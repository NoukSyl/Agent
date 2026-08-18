const Groq = require("groq-sdk");
const { schemas, executeTool } = require("./tools");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const DEFAULT_MODEL =
  process.env.GROQ_MODEL ||
  "openai/gpt-oss-120b";

const MAX_TOOL_STEPS = Number(
  process.env.MAX_TOOL_STEPS || 8
);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new Error("Execution force-stopped by Owner.");
  }
}

async function completion(body, signal) {
  const maxRetries = Number(process.env.GROQ_MAX_RETRIES || 4);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(signal);

    try {
      return await groq.chat.completions.create(body, { signal });
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Execution force-stopped by Owner.");
      }

      const status = error?.status || error?.statusCode;
      if (status !== 429 || attempt === maxRetries) {
        throw error;
      }

      const retryAfter = Number(error?.headers?.["retry-after"]);
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(15000, 1000 * Math.pow(2, attempt));

      await sleep(delay);
    }
  }
}

async function runAgent({
  system,
  messages,
  model = DEFAULT_MODEL,
  onTool,
  onText,
  signal
}) {
  const conversation = [
    { role: "system", content: system },
    ...messages
  ];

  for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
    throwIfAborted(signal);

    const response = await completion(
      {
        model,
        messages: conversation,
        tools: schemas,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning_effort: model.includes("gpt-oss") ? "medium" : undefined,
        max_completion_tokens: 6000
      },
      signal
    );

    throwIfAborted(signal);

    const message = response.choices?.[0]?.message;
    if (!message) throw new Error("Model returned no message");

    conversation.push(message);

    if (message.tool_calls?.length) {
      for (const toolCall of message.tool_calls) {
        throwIfAborted(signal);

        const name = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          args = {};
        }

        if (onTool) await onTool(name, args, step, model);

        let result;
        try {
          result = await executeTool(name, args, { signal });
        } catch (error) {
          result = `Tool error: ${error.message}`;
        }

        conversation.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name,
          content: String(result).slice(0, 30000)
        });
      }
      continue;
    }

    const text = String(message.content || "").trim();
    if (!text) {
      conversation.push({
        role: "user",
        content:
          "Continue the task. Your previous response was empty. Either use the necessary tools or provide a useful report."
      });
      continue;
    }

    if (onText) await onText(text, model);

    return {
      completed: true,
      text,
      steps: step,
      model,
      messages: conversation
    };
  }

  return {
    completed: false,
    text: "Agent reached the tool-step limit for this cycle.",
    steps: MAX_TOOL_STEPS,
    model,
    messages: conversation
  };
}

module.exports = {
  runAgent,
  MODEL: DEFAULT_MODEL,
  DEFAULT_MODEL,
  MAX_TOOL_STEPS
};
