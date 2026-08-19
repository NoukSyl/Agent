const express = require("express");
const path = require("path");

const {
  runWorker,
  WORKER_MODEL
} = require("./runtime/worker");

const {
  createTask,
  updateTask,
  addTaskEvent,
  addDecision,
  memorySave
} = require("./runtime/memory");

const {
  configured: authConfigured,
  isAuthenticated,
  login,
  logout,
  requireAuth
} = require("./runtime/auth");

const PORT = Number(process.env.PORT) || 8080;
const MAX_CYCLES = Number(process.env.MAX_AGENT_CYCLES || 8);

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const state = {
  taskId: null,
  task: null,
  status: "idle",
  cycle: 0,
  awaitingOwner: false,
  ownerDecision: null,
  agentStatus: "idle",
  agentMessage: "",
  events: [],
  abortController: null,
  // Set of "tool:args" signatures used in the most recently finished
  // cycle, kept only to detect a cycle that repeated the previous one
  // exactly (stuck loop). Reset whenever a new task/block starts.
  priorCycleSignatures: null,
  // Rolling digest of what's been tried across cycles in this task,
  // carried forward as feedback for the next cycle/block.
  taskDigest: ""
};

function publicState() {
  return {
    taskId: state.taskId,
    task: state.task,
    status: state.status,
    cycle: state.cycle,
    awaitingOwner: state.awaitingOwner,
    ownerDecision: state.ownerDecision,
    agentStatus: state.agentStatus,
    agentMessage: state.agentMessage,
    events: state.events,
    maxCycles: MAX_CYCLES,
    models: {
      agent: WORKER_MODEL
    },
    authConfigured: authConfigured(),
    forceStoppable: ["starting", "running"].includes(state.status)
  };
}

function pushEvent(type, actor, message) {
  const event = {
    time: new Date().toISOString(),
    type,
    actor,
    message
  };

  state.events.push(event);
  if (state.events.length > 300) state.events.shift();

  if (state.taskId) {
    addTaskEvent(
      state.taskId,
      actor,
      type,
      message,
      state.cycle
    ).catch(console.error);
  }

  return event;
}

// Render a tool's raw result into something short and readable for
// the activity log. Terminal results are JSON {exitCode,stdout,stderr};
// surface those directly instead of a JSON blob.
function formatToolResult(name, result) {
  const raw = String(result);

  if (name === "terminal") {
    try {
      const { exitCode, stdout, stderr } = JSON.parse(raw);
      const out = String(stdout || "").trim();
      const err = String(stderr || "").trim();
      let text = `exit ${exitCode}`;
      if (out) text += ` | stdout: ${out.slice(0, 300)}`;
      if (err) text += ` | stderr: ${err.slice(0, 300)}`;
      return text;
    } catch {
      // fall through to generic truncation
    }
  }

  return raw.replace(/\s+/g, " ").trim().slice(0, 300);
}

function callSignature(name, args) {
  return `${name}:${JSON.stringify(args)}`;
}

function isForceStopped(error) {
  return state.abortController?.signal.aborted ||
    String(error?.message || "").includes("force-stopped by Owner");
}

async function finishStopped(reason = "Owner force-stopped execution.") {
  state.status = "stopped";
  state.awaitingOwner = false;
  state.agentStatus = "stopped";

  if (state.taskId) {
    await updateTask(state.taskId, { status: "stopped" }).catch(console.error);
    await addDecision(state.taskId, "owner", "force_stop", reason).catch(console.error);
  }

  pushEvent("force_stop", "owner", reason);
}

async function completeTask(task) {
  state.status = "completed";
  state.awaitingOwner = false;
  state.agentStatus = "completed";

  await updateTask(state.taskId, {
    status: "completed",
    result: state.agentMessage,
    completed_at: new Date().toISOString()
  });

  pushEvent("completed", "agent", state.agentMessage.slice(0, 5000));

  try {
    await memorySave({
      scope: "task",
      memory_key: `task-${state.taskId}`,
      content: `Task: ${task}\n\nAgent: ${state.agentMessage}`,
      importance: 6,
      tags: ["completed-task"]
    });
  } catch (error) {
    pushEvent("memory_error", "system", error.message);
  }
}

async function runTaskBlock(task, feedback = "") {
  while (state.cycle < MAX_CYCLES) {
    if (state.abortController.signal.aborted) {
      await finishStopped();
      return;
    }

    state.ownerDecision = null;
    state.cycle++;

    await updateTask(state.taskId, { cycle: state.cycle });
    pushEvent(
      "cycle",
      "system",
      `Starting agent cycle ${state.cycle}/${MAX_CYCLES}`
    );

    state.agentStatus = "working";

    const result = await runWorker({
      task,
      feedback,
      cycle: state.cycle,
      taskId: state.taskId,
      signal: state.abortController.signal,
      onTool: async (name, args, step, model) => {
        pushEvent(
          "tool",
          "agent",
          `${name} ${JSON.stringify(args)} [${model}]`
        );
      },
      onToolResult: async (name, args, toolResult, step, model, repeated) => {
        pushEvent(
          repeated ? "tool_repeated" : "tool_result",
          "agent",
          formatToolResult(name, toolResult)
        );
      },
      onText: async text => {
        state.agentMessage = text;
        pushEvent("agent", "agent", text.slice(0, 5000));
      }
    });

    state.agentMessage = result.text || "Agent produced no report.";
    state.agentStatus = "completed";

    pushEvent(
      "agent_report",
      "agent",
      state.agentMessage.slice(0, 5000)
    );

    // Persist what this cycle actually tried, deterministically —
    // don't rely on the model remembering to call memory_save.
    if (result.digest) {
      state.taskDigest = state.taskDigest
        ? `${state.taskDigest}\n\nCycle ${state.cycle}:\n${result.digest}`
        : `Cycle ${state.cycle}:\n${result.digest}`;

      memorySave({
        scope: result.scope || "global",
        memory_key: `cycle-${state.cycle}-digest`,
        content: result.digest,
        importance: 4,
        tags: ["auto-digest"]
      }).catch(error => pushEvent("memory_error", "system", error.message));
    }

    if (state.abortController.signal.aborted) {
      await finishStopped();
      return;
    }

    // A single agent is responsible for its own verification.
    // A non-empty final report means the agent completed its pass.
    if (result.completed) {
      await completeTask(task);
      return;
    }

    // Stuck-loop guard: if this cycle called the exact same set of
    // tools with the exact same arguments as the previous cycle, more
    // cycles won't help — a fresh cycle just re-explores from scratch.
    // Stop early and hand it to the Owner instead of burning the rest
    // of the budget repeating the same steps.
    const signatures = new Set(
      (result.toolTrace || []).map(t => callSignature(t.name, t.args))
    );
    const samePattern =
      state.priorCycleSignatures &&
      signatures.size > 0 &&
      signatures.size === state.priorCycleSignatures.size &&
      [...signatures].every(s => state.priorCycleSignatures.has(s));
    state.priorCycleSignatures = signatures;

    if (samePattern) {
      pushEvent(
        "stuck_detected",
        "system",
        `Agent repeated the same ${signatures.size} tool call(s) as the previous cycle without new progress. Stopping early at cycle ${state.cycle} instead of burning the remaining budget.`
      );
      break;
    }

    feedback = state.taskDigest
      ? `${state.taskDigest}\n\nDo not repeat any of the exact calls above. Use their results, try a different approach, or report what is blocking you.`
      : "Continue the task from the current workspace. Review your previous work, identify what remains incomplete, fix it, and verify the result.";

    if (state.cycle >= MAX_CYCLES) break;
  }

  state.status = "awaiting_owner";
  state.awaitingOwner = true;
  state.agentStatus = "waiting_owner";

  await updateTask(state.taskId, { status: "awaiting_owner" });
  pushEvent(
    "cycle_limit",
    "system",
    `Reached cycle ${state.cycle}/${MAX_CYCLES}. Owner can continue or stop.`
  );
}

async function runTask(task, existingTaskId = null) {
  state.abortController = new AbortController();
  state.priorCycleSignatures = null;

  if (!existingTaskId) {
    const dbTask = await createTask(task);
    state.taskId = dbTask.id;
  }

  state.status = "running";
  state.awaitingOwner = false;
  state.ownerDecision = null;
  pushEvent("task", "owner", task);

  try {
    await runTaskBlock(task);
  } catch (error) {
    if (isForceStopped(error)) {
      await finishStopped();
      return;
    }

    state.status = "error";
    state.agentStatus = "error";
    pushEvent("error", "system", error.message);

    if (state.taskId) {
      await updateTask(state.taskId, {
        status: "error",
        result: error.stack
      }).catch(console.error);
    }
  } finally {
    state.abortController = null;
  }
}

// Optional auth endpoints
app.post("/api/auth/login", async (req, res) => {
  try {
    const result = await login(
      String(req.body?.username || ""),
      String(req.body?.password || "")
    );
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    await logout(req, res);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/state", (req, res) => {
  res.json(publicState());
});

app.post("/api/task", async (req, res) => {
  const task = String(req.body?.task || "").trim();
  if (!task) return res.status(400).json({ error: "task required" });

  if (
    ["starting", "running", "stopping", "awaiting_owner"].includes(
      state.status
    )
  ) {
    return res.status(409).json({ error: "A task is already active." });
  }

  state.taskId = null;
  state.task = task;
  state.status = "starting";
  state.cycle = 0;
  state.awaitingOwner = false;
  state.ownerDecision = null;
  state.agentStatus = "idle";
  state.agentMessage = "";
  state.events = [];
  state.taskDigest = "";
  state.priorCycleSignatures = null;

  runTask(task).catch(async error => {
    console.error(error);
    state.status = "error";
    state.agentStatus = "error";
    pushEvent("error", "system", error.message);
  });

  res.json({ ok: true });
});

app.post("/api/owner/decision", async (req, res) => {
  const decision = req.body?.decision;
  if (!["continue", "stop"].includes(decision)) {
    return res.status(400).json({
      error: "decision must be continue or stop"
    });
  }

  if (!state.awaitingOwner) {
    return res.status(409).json({
      error: "No Owner decision is currently required."
    });
  }

  if (decision === "stop") {
    state.awaitingOwner = false;
    if (state.abortController) state.abortController.abort();
    await finishStopped("Owner stopped after cycle limit.");
    return res.json({ ok: true });
  }

  state.awaitingOwner = false;
  state.ownerDecision = "continue";
  state.cycle = 0;
  state.status = "running";
  state.agentStatus = "idle";

  await updateTask(state.taskId, {
    status: "running",
    cycle: 0
  });

  pushEvent(
    "owner_decision",
    "owner",
    `Owner approved another ${MAX_CYCLES}-cycle block.`
  );

  if (!state.abortController) {
    state.abortController = new AbortController();
  }

  state.priorCycleSignatures = null;

  runTaskBlock(
    state.task,
    state.taskDigest
      ? `${state.taskDigest}\n\nThe Owner approved another cycle block. Re-check your previous work, do not repeat the exact calls above, and complete anything still missing.`
      : "Continue from the current workspace. Re-check your previous work and complete anything still missing."
  )
    .catch(async error => {
      if (isForceStopped(error)) return finishStopped();

      state.status = "error";
      state.agentStatus = "error";
      pushEvent("error", "system", error.message);

      await updateTask(state.taskId, {
        status: "error",
        result: error.stack
      }).catch(console.error);
    })
    .finally(() => {
      state.abortController = null;
    });

  res.json({ ok: true });
});

app.post("/api/force-stop", async (req, res) => {
  if (
    !["starting", "running"].includes(state.status) ||
    !state.abortController
  ) {
    return res.status(409).json({
      error: "No running task can be force-stopped."
    });
  }

  state.status = "stopping";
  state.awaitingOwner = false;
  pushEvent(
    "force_stop_requested",
    "owner",
    "Force stop requested from web UI."
  );

  state.abortController.abort();

  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`AI Organization listening on :${PORT}`);
  console.log(`Agent model: ${WORKER_MODEL}`);
  console.log(`Web auth configured: ${authConfigured()}`);
});
