const fs = require("fs/promises");
const path = require("path");

const {
  runAgent
} = require("./agent");

async function loadPrompt() {
  return fs.readFile(
    path.join(
      __dirname,
      "..",
      "agents",
      "manager.md"
    ),
    "utf8"
  );
}

async function reviewWorker({
  task,
  workerReport,
  cycle
}) {
  const prompt =
    await loadPrompt();

  const system = `
${prompt}

You are reviewing cycle ${cycle}.

Return JSON only:

{
  "decision": "PASS" | "ASK_WORKER" | "REWORK" | "PAUSE" | "OWNER_INPUT",
  "message": "clear explanation"
}
`;

  const result =
    await runAgent({
      system,

      messages: [
        {
          role: "user",
          content:
            `OWNER TASK:\n${task}\n\nWORKER REPORT:\n${workerReport}`
        }
      ]
    });

  let parsed;

  try {
    parsed =
      JSON.parse(result.text);
  } catch {
    parsed = {
      decision: "OWNER_INPUT",
      message:
        "Manager returned invalid JSON and requires Owner review."
    };
  }

  const valid = [
    "PASS",
    "ASK_WORKER",
    "REWORK",
    "PAUSE",
    "OWNER_INPUT"
  ];

  if (!valid.includes(parsed.decision)) {
    parsed.decision =
      "OWNER_INPUT";
  }

  return parsed;
}

module.exports = {
  reviewWorker
};