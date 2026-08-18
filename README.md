# Groq AI Organization v2

Two AI agents only:
- Level 2 Manager
- Level 1 Worker
- Level 3 Owner = human

Both use `openai/gpt-oss-120b`.

Worker can use terminal/files in `/app/workspace`. Manager reviews the worker and uses progressive supervision: Observe -> Ask -> Understand -> Correct -> Rework -> Pause -> Escalate.

The task runs in blocks of 8 cycles. If the task is not complete after the configured 8 cycles, execution pauses and the Owner is asked whether to continue. Continue grants another 8-cycle block; Stop ends it.

Railway variables:
```
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-120b
MAX_AGENT_CYCLES=8
GROQ_MAX_RETRIES=4
TERMINAL_TIMEOUT_MS=30000
WORKSPACE=/app/workspace
```
