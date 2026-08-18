# AI Organization — Railway + Groq

Hierarchy: Level 3 Owner → Level 2 Manager 1/2 → Level 1 Worker 1/2/3.
All agents use `openai/gpt-oss-120b` by default.

## Railway Variables

`GROQ_API_KEY=...`
`GROQ_MODEL=openai/gpt-oss-120b`
`MAX_AGENT_TURNS=20`
`TERMINAL_TIMEOUT_MS=30000`
`WORKSPACE=/app/workspace`
`REASONING_EFFORT=medium`

Railway supplies `PORT` automatically.

## Deploy

Push the folder to GitHub, create a Railway service from the repo, and add `GROQ_API_KEY` in Variables. Start command is `npm start`.

Workers run shell commands in the service container with `/app/workspace` as cwd. The platform/container remains the isolation boundary.

## Supervision

Observe → Ask → Understand → Correct → Warn → Pause → Escalate.

This is a starter implementation. It keeps state in memory, so a process restart resets agent state. Add authentication and persistent storage before exposing the Owner UI publicly.
