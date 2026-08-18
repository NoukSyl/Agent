# AI Peer Organization v4

Two independent AI workers collaborate on the same task:

- **Worker A**: primary implementation worker, default `openai/gpt-oss-120b`.
- **Worker B**: independent peer/auditor worker, default `llama-3.1-8b-instant` for low-latency review.
- Both are real model instances with the same tool capabilities. There is no Manager role pretending to be a second AI.
- Worker B audits the actual workspace and Worker A's claims. Findings become feedback for the next Worker A pass.
- A PASS requires Worker B's independent verification.

## Web authentication

Set these Railway variables:

```text
AUTH_USERNAME=your-owner-name
AUTH_PASSWORD=use-a-long-random-password
AUTH_SESSION_TTL_MS=28800000
NODE_ENV=production
```

The web UI uses an HttpOnly, SameSite=Strict session cookie. In production the cookie is also Secure.

## Agent variables

```text
GROQ_API_KEY=...
GROQ_WORKER_MODEL=openai/gpt-oss-120b
GROQ_WORKER_B_MODEL=llama-3.1-8b-instant
MAX_AGENT_CYCLES=8
MAX_TOOL_STEPS=8
GROQ_MAX_RETRIES=4
TERMINAL_TIMEOUT_MS=30000
WORKSPACE=/app/workspace
```

`llama-3.1-8b-instant` is used for Worker B because Groq currently lists it as a production model at about 560 tokens/sec, while GPT-OSS 120B is about 500 tokens/sec. It supports tool use and JSON mode. If you want a different critic model, set `GROQ_WORKER_B_MODEL`.

## Force stop

The web UI has a **FORCE STOP** button. It uses `AbortController` to cancel the active Groq request and terminates the active shell command when possible. The task is persisted as `stopped`.

## Important security note

Worker tools can execute shell commands. Deploy this service only in an isolated environment and do not expose it without authentication. Keep secrets out of the agent workspace and environment where possible.
