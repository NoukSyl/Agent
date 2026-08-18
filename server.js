const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const {
  runWorkerA,
  runWorkerB,
  WORKER_A_MODEL,
  WORKER_B_MODEL
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
const WORKSPACE = path.resolve(process.env.WORKSPACE || "/app/workspace");

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
  workerAStatus: "idle",
  workerBStatus: "idle",
  workerAMessage: "",
  workerBMessage: "",
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
    workerAStatus: state.workerAStatus,
    workerBStatus: state.workerBStatus,
    workerAMessage: state.workerAMessage,
    workerBMessage: state.workerBMessage,
    events: state.events,
    maxCycles: MAX_CYCLES,
    models: {
      workerA: WORKER_A_MODEL,
      workerB: WORKER_B_MODEL
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

function parsePeerReview(text) {
  const raw = String(text || "").trim();

  try {
    const parsed = JSON.parse(raw);
    return {
      verdict: parsed.verdict === "PASS" ? "PASS" : "FINDINGS",
      message: parsed.summary || parsed.message || raw,
      nextAction: parsed.next_action || ""
    };
  } catch {}

  const firstLine = raw.split("\n")[0].toUpperCase();
  const pass = firstLine.includes("PASS") && !firstLine.includes("FINDINGS");

  return {
    verdict: pass ? "PASS" : "FINDINGS",
    message: raw,
    nextAction: ""
  };
}

async function finishStopped(reason = "Owner force-stopped execution.") {
  state.status = "stopped";
  state.awaitingOwner = false;
  state.workerAStatus = "stopped";
  state.workerBStatus = "stopped";

  if (state.taskId) {
    await updateTask(state.taskId, { status: "stopped" }).catch(console.error);
    await addDecision(state.taskId, "owner", "force_stop", reason).catch(console.error);
  }

  pushEvent("force_stop", "owner", reason);
}

async function completeTask(task, review) {
  state.status = "completed";
  state.awaitingOwner = false;
  state.workerAStatus = "completed";
  state.workerBStatus = "completed";

  await updateTask(state.taskId, {
    status: "completed",
    result: state.workerAMessage,
    completed_at: new Date().toISOString()
  });

  pushEvent("completed", "worker-b", review.message);

  try {
    await memorySave({
      scope: "task",
      memory_key: `task-${state.taskId}`,
      content:
        `Task: ${task}\n\nWorker A: ${state.workerAMessage}\n\nWorker B review: ${review.message}`,
      importance: 6,
      tags: ["completed-task", "peer-reviewed"]
    });
  } catch (error) {
    pushEvent("memory_error", "system", error.message);
  }
}

async function runTaskBlock(task, managerFeedback = "") {
  while (state.cycle < MAX_CYCLES) {
    if (state.abortController.signal.aborted) {
      await finishStopped();
      return;
    }

    state.ownerDecision = null;
    state.cycle++;

    await updateTask(state.taskId, { cycle: state.cycle });
    pushEvent("cycle", "system", `Starting peer cycle ${state.cycle}/${MAX_CYCLES}`);

    state.workerAStatus = "working";
    state.workerBStatus = "waiting";

    const workerA = await runWorkerA({
      task,
      feedback: managerFeedback,
      cycle: state.cycle,
      signal: state.abortController.signal,
      onTool: async (name, args, step, model) => {
        pushEvent("tool", "worker-a", `${name} ${JSON.stringify(args)} [${model}]`);
      },
      onText: async text => {
        state.workerAMessage = text;
        pushEvent("worker", "worker-a", text.slice(0, 5000));
      }
    });

    state.workerAMessage = workerA.text || "Worker A produced no report.";
    state.workerAStatus = "waiting_peer";
    pushEvent("worker_report", "worker-a", state.workerAMessage.slice(0, 5000));

    if (state.abortController.signal.aborted) {
      await finishStopped();
      return;
    }

    state.workerBStatus = "working";
    const workerB = await runWorkerB({
      task,
      workerAReport: state.workerAMessage,
      cycle: state.cycle,
      signal: state.abortController.signal,
      onTool: async (name, args, step, model) => {
        pushEvent("tool", "worker-b", `${name} ${JSON.stringify(args)} [${model}]`);
      },
      onText: async text => {
        state.workerBMessage = text;
        pushEvent("peer_review", "worker-b", text.slice(0, 5000));
      }
    });

    state.workerBMessage = workerB.text || "Worker B produced no review.";
    state.workerBStatus = "reviewed";

    const review = parsePeerReview(state.workerBMessage);
    await addDecision(
      state.taskId,
      "worker-b",
      review.verdict,
      review.message
    );

    if (review.verdict === "PASS") {
      await completeTask(task, review);
      return;
    }

    managerFeedback =
      `WORKER B FOUND FINDINGS:\n${state.workerBMessage}\n\nNEXT ACTION:\n${review.nextAction || "Investigate every finding against the real workspace, fix confirmed defects, and verify the result."}`;

    pushEvent(
      "peer_feedback",
      "worker-b",
      review.message.slice(0, 5000)
    );

    if (state.cycle >= MAX_CYCLES) break;
  }

  state.status = "awaiting_owner";
  state.awaitingOwner = true;
  state.workerAStatus = "waiting_owner";
  state.workerBStatus = "waiting_owner";

  await updateTask(state.taskId, { status: "awaiting_owner" });
  pushEvent(
    "cycle_limit",
    "system",
    `Reached ${MAX_CYCLES} peer-review cycles. Owner can continue or stop.`
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
    await runTaskBlock(task, state.workerBMessage || "");
  } catch (error) {
    if (isForceStopped(error)) {
      await finishStopped();
      return;
    }

    console.error(error);
    state.status = "error";
    state.awaitingOwner = false;
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

app.get("/api/auth/status", (req, res) => {
  res.json({
    configured: authConfigured(),
    authenticated: authConfigured() && isAuthenticated(req)
  });
});

app.post("/api/auth/login", (req, res) => {
  if (!authConfigured()) {
    return res.status(503).json({
      error: "Set AUTH_USERNAME and AUTH_PASSWORD before using the web UI."
    });
  }

  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");

  if (!login(req, username, password)) {
    return res.status(401).json({ error: "Invalid username or password." });
  }

  res.json({ ok: true });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  logout(req);
  res.json({ ok: true });
});

app.use("/api", requireAuth);

app.get("/api/state", (req, res) => {
  res.json(publicState());
});

app.post("/api/task", async (req, res) => {
  const task = String(req.body?.task || "").trim();
  if (!task) return res.status(400).json({ error: "task required" });

  if (["starting", "running", "stopping", "awaiting_owner"].includes(state.status)) {
    return res.status(409).json({ error: "A task is already active." });
  }

  state.taskId = null;
  state.task = task;
  state.status = "starting";
  state.cycle = 0;
  state.awaitingOwner = false;
  state.ownerDecision = null;
  state.workerAStatus = "idle";
  state.workerBStatus = "idle";
  state.workerAMessage = "";
  state.workerBMessage = "";
  state.events = [];

  runTask(task).catch(async error => {
    console.error(error);
    state.status = "error";
    pushEvent("error", "system", error.message);
  });

  res.json({ ok: true });
});

app.post("/api/owner/decision", async (req, res) => {
  const decision = req.body?.decision;
  if (!["continue", "stop"].includes(decision)) {
    return res.status(400).json({ error: "decision must be continue or stop" });
  }

  if (!state.awaitingOwner) {
    return res.status(409).json({ error: "No Owner decision is currently required." });
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
  state.workerAStatus = "idle";
  state.workerBStatus = "idle";

  await updateTask(state.taskId, { status: "running", cycle: 0 });
  pushEvent("owner_decision", "owner", `Owner approved another ${MAX_CYCLES}-cycle block.`);

  if (!state.abortController) state.abortController = new AbortController();

  runTaskBlock(state.task, state.workerBMessage || "")
    .catch(async error => {
      if (isForceStopped(error)) return finishStopped();
      state.status = "error";
      pushEvent("error", "system", error.message);
      await updateTask(state.taskId, { status: "error", result: error.stack }).catch(console.error);
    })
    .finally(() => {
      state.abortController = null;
    });

  res.json({ ok: true });
});

app.post("/api/force-stop", async (req, res) => {
  if (!["starting", "running"].includes(state.status) || !state.abortController) {
    return res.status(409).json({ error: "No running task can be force-stopped." });
  }

  state.status = "stopping";
  state.awaitingOwner = false;
  pushEvent("force_stop_requested", "owner", "Force stop requested from web UI.");
  state.abortController.abort();

  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`AI Organization listening on :${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Worker A: ${WORKER_A_MODEL}`);
  console.log(`Worker B: ${WORKER_B_MODEL}`);
  console.log(`Web auth configured: ${authConfigured()}`);
});
