const fs = require("fs/promises");
const path = require("path");
const { runAgent } = require("./agent");
const { memorySearch } = require("./memory");

const WORKER_A_MODEL =
  process.env.GROQ_WORKER_MODEL ||
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";

const WORKER_B_MODEL =
  process.env.GROQ_WORKER_B_MODEL ||
  "llama-3.1-8b-instant";

async function loadPrompt(name) {
  return fs.readFile(
    path.join(__dirname, "..", "agents", name),
    "utf8"
  );
}

async function loadMemory(task) {
  try {
    return await memorySearch(task, "global", 8);
  } catch {
    return [];
  }
}

function buildMemoryText(memories) {
  return memories.length
    ? JSON.stringify(memories)
    : "No relevant persistent memory found.";
}

async function runWorkerA({ task, feedback = "", cycle, onTool, onText, signal }) {
  const prompt = await loadPrompt("worker-a.md");
  const memories = await loadMemory(task);

  const system = `
${prompt}

CURRENT CYCLE: ${cycle}

RELEVANT PERSISTENT MEMORY:
${buildMemoryText(memories)}

WORKER B FEEDBACK FROM THE PREVIOUS PASS:
${feedback || "None."}

You are Worker A. Execute the Owner's task, inspect the actual workspace, make the required changes, and verify them. Worker B is an independent peer, not your supervisor. Treat its findings as claims to investigate, not instructions to blindly trust.
`;

  return runAgent({
    model: WORKER_A_MODEL,
    system,
    messages: [{ role: "user", content: `OWNER TASK:\n${task}` }],
    onTool,
    onText,
    signal
  });
}

async function runWorkerB({ task, workerAReport, cycle, onTool, onText, signal }) {
  const prompt = await loadPrompt("worker-b.md");
  const memories = await loadMemory(task);

  const system = `
${prompt}

CURRENT CYCLE: ${cycle}

RELEVANT PERSISTENT MEMORY:
${buildMemoryText(memories)}

You are Worker B, an independent peer worker and adversarial reviewer. Inspect the real workspace and verify Worker A's claims. You have the same tool access as Worker A. Do not approve work merely because the report sounds convincing. If something is wrong, state exactly what is wrong and what evidence supports it.
`;

  return runAgent({
    model: WORKER_B_MODEL,
    system,
    messages: [
      {
        role: "user",
        content:
          `OWNER TASK:\n${task}\n\nWORKER A REPORT:\n${workerAReport || "No report."}\n\nAudit the current workspace and produce a concise peer-review report. Do not claim success without evidence.`
      }
    ],
    onTool,
    onText,
    signal
  });
}

module.exports = {
  runWorkerA,
  runWorkerB,
  WORKER_A_MODEL,
  WORKER_B_MODEL
};
