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
  abortController: null
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
      signal: state.abortController.signal,
      onTool: async (name, args, step, model) => {
        pushEvent(
          "tool",
          "agent",
          `${name} ${JSON.stringify(args)} [${model}]`
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

    feedback =
      "Continue the task from the current workspace. Review your previous work, identify what remains incomplete, fix it, and verify the result.";

    if (state.cycle >= MAX_CYCLES) break;
  }

  state.status = "awaiting_owner";
  state.awaitingOwner = true;
  state.agentStatus = "waiting_owner";

  await updateTask(state.taskId, { status: "awaiting_owner" });
  pushEvent(
    "cycle_limit",
    "system",
    `Reached ${MAX_CYCLES} agent cycles. Owner can continue or stop.`
  );
}

async function runTask(task, existingTaskId = null) {
  state.abortController = new AbortController();

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

  runTaskBlock(
    state.task,
    "Continue from the current workspace. Re-check your previous work and complete anything still missing."
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
