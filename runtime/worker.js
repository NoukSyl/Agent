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

async function runWorker({
  task,
  feedback = "",
  cycle,
  onTool,
  onText,
  signal
}) {
  const prompt = await loadPrompt();
  const memories = await loadMemory(task);

  const system = `
${prompt}

CURRENT CYCLE: ${cycle}

RELEVANT PERSISTENT MEMORY:
${buildMemoryText(memories)}

PREVIOUS FEEDBACK:
${feedback || "None."}

You are the single primary AI agent. Execute the Owner's task directly in the real workspace.
Before finishing, perform a concise self-review: verify that the requested work was actually completed,
check important files/results, and fix any confirmed issue you find. Do not wait for or mention another
worker or reviewer. Do not claim completion without evidence.
`;

  return runAgent({
    model: WORKER_MODEL,
    system,
    messages: [{ role: "user", content: `OWNER TASK:\n${task}` }],
    onTool,
    onText,
    signal
  });
}

module.exports = {
  runWorker,
  WORKER_MODEL
};
