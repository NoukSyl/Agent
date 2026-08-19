const fs = require("fs/promises");
const path = require("path");
const { runAgent } = require("./agent");
const { memorySearch } = require("./memory");

const WORKER_MODEL =
  process.env.GROQ_WORKER_MODEL ||
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";

async function loadPrompt() {
  return fs.readFile(
    path.join(__dirname, "..", "agents", "worker.md"),
    "utf8"
  );
}

// When memory is scoped to this specific task, every entry in that
// scope is relevant by definition — so fetch all of it (query "")
// instead of relying on a fuzzy ilike match against the task text,
// which was silently dropping auto-saved cycle digests.
async function loadMemory(task, scope) {
  const query = scope.startsWith("task:") ? "" : task;
  try {
    return await memorySearch(query, scope, 20);
  } catch {
    return [];
  }
}

function buildMemoryText(memories) {
  return memories.length
    ? JSON.stringify(memories)
    : "No relevant persistent memory found.";
}

// Turns this cycle's tool calls into a short, deduplicated digest —
// generated deterministically from the trace, not left to the model's
// discretion to save via memory_save. This is what gets carried into
// the next cycle's prompt and persisted to memory automatically.
function buildDigest(toolTrace = []) {
  const byCall = new Map();
  for (const t of toolTrace) {
    const call = `${t.name} ${JSON.stringify(t.args)}`;
    const resultSnippet = String(t.result || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    byCall.set(call, resultSnippet);
  }
  return [...byCall.entries()]
    .map(([call, result]) => `- ${call} \u2192 ${result}`)
    .join("\n");
}

async function runWorker({
  task,
  feedback = "",
  cycle,
  taskId,
  onTool,
  onToolResult,
  onText,
  signal
}) {
  const prompt = await loadPrompt();
  const scope = taskId ? `task:${taskId}` : "global";
  const memories = await loadMemory(task, scope);

  const system = `
${prompt}

CURRENT CYCLE: ${cycle}

PRIOR CYCLE FINDINGS (already tried in this task \u2014 do not repeat identical steps):
${feedback || "None yet \u2014 this is the first cycle."}

RELEVANT PERSISTENT MEMORY:
${buildMemoryText(memories)}

You are the single primary AI agent. Execute the Owner's task directly in the real workspace.
Before finishing, perform a concise self-review: verify that the requested work was actually completed,
check important files/results, and fix any confirmed issue you find. Do not wait for or mention another
worker or reviewer. Do not claim completion without evidence.

Rules to avoid wasted cycles:
- Never call the same tool with the exact same arguments twice \u2014 check PRIOR CYCLE FINDINGS first.
- If more than one file or approach could match the task, pick the single most likely one and say why in
  your report, instead of testing every candidate every cycle.
- You have a limited number of tool calls this cycle \u2014 investigate efficiently, then act.
- Before overwriting or replacing an existing file's contents, say so explicitly in your report and why.
`;

  const result = await runAgent({
    model: WORKER_MODEL,
    system,
    messages: [{ role: "user", content: `OWNER TASK:\n${task}` }],
    onTool,
    onToolResult,
    onText,
    signal
  });

  return {
    ...result,
    digest: buildDigest(result.toolTrace),
    scope
  };
}

module.exports = {
  runWorker,
  WORKER_MODEL
};
