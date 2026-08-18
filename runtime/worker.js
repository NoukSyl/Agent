const fs = require("fs/promises");
const path = require("path");

const {
  runAgent
} = require("./agent");

const {
  memorySearch
} = require("./memory");

async function loadPrompt() {
  return fs.readFile(
    path.join(
      __dirname,
      "..",
      "agents",
      "worker.md"
    ),
    "utf8"
  );
}

async function runWorker({
  task,
  managerInstruction = "",
  cycle,
  onTool,
  onText
}) {
  const prompt =
    await loadPrompt();

  let memories = [];

  try {
    memories =
      await memorySearch(
        task,
        "global",
        8
      );
  } catch {
    memories = [];
  }

  const memoryText =
    memories.length
      ? JSON.stringify(memories)
      : "No relevant persistent memory found.";

  const system = `
${prompt}

CURRENT CYCLE: ${cycle}

RELEVANT PERSISTENT MEMORY:
${memoryText}

MANAGER INSTRUCTION:
${managerInstruction || "None."}

You are currently executing the Owner's task.
`;

  return runAgent({
    system,

    messages: [
      {
        role: "user",
        content:
          `OWNER TASK:\n${task}`
      }
    ],

    onTool,
    onText
  });
}

module.exports = {
  runWorker
};