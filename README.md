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
MAX_TOOL_STEPS=8
MAX_AGENT_CYCLES=8
GROQ_MAX_RETRIES=4
PORT=8080
```

`GROQ_WORKER_MODEL` overrides `GROQ_MODEL` for the primary agent.

## Start

```bash
npm install
npm start
```
