# Groq AI Organization

A single autonomous AI agent that executes Owner tasks directly in the real workspace.

## Architecture

- **AI Agent**: one primary agent using the configured Groq model.
- **Self-review**: the agent verifies important results before reporting completion.
- **Tools**: filesystem, terminal, memory, and other configured tools.
- **Owner control**: the Owner can continue after the cycle limit or force-stop execution.

There is no Worker B / peer-review agent.

## Environment

```env
GROQ_API_KEY=your_key
GROQ_MODEL=openai/gpt-oss-120b
GROQ_WORKER_MODEL=openai/gpt-oss-120b
MAX_TOOL_STEPS=16
MAX_AGENT_CYCLES=8
GROQ_MAX_RETRIES=4
PORT=8080
```

`GROQ_WORKER_MODEL` overrides `GROQ_MODEL` for the primary agent.

## Cycle memory & stuck-loop protection

Each cycle used to start with a blank slate: only a generic "continue" message, no record of what the
previous cycle had already tried. On an ambiguous or hard task, the agent re-explored the same files and
re-ran the same failing commands every cycle, burning the entire budget without progress.

Now:

- Every cycle's tool calls are deterministically summarized into a digest and carried into the next
  cycle's prompt as `PRIOR CYCLE FINDINGS`, and auto-saved to task-scoped persistent memory (not left to
  the model to remember to call `memory_save`).
- Calling the exact same tool with the exact same arguments twice in one cycle returns a cached result
  plus a nudge instead of re-running it.
- If a whole cycle repeats the exact same tool calls as the previous cycle, execution stops early and
  escalates to the Owner instead of quietly repeating for the rest of the budget.

## Start

```bash
npm install
npm start
```
