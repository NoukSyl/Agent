const express = require("express");
const fs = require("fs/promises");
const path = require("path");

const {
  runWorker
} = require("./runtime/worker");

const {
  reviewWorker
} = require("./runtime/manager");

const {
  createTask,
  updateTask,
  addTaskEvent,
  addDecision,
  memorySave
} = require("./runtime/memory");

const PORT =
  Number(process.env.PORT) || 8080;

const MAX_CYCLES =
  Number(
    process.env.MAX_AGENT_CYCLES || 8
  );

const WORKSPACE =
  path.resolve(
    process.env.WORKSPACE ||
      "/app/workspace"
  );

const app = express();

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);

const state = {
  taskId: null,
  task: null,
  status: "idle",

  cycle: 0,

  awaitingOwner: false,

  ownerDecision: null,

  workerStatus: "idle",

  managerStatus: "idle",

  workerMessage: "",

  managerMessage: "",

  events: []
};

function pushEvent(
  type,
  actor,
  message
) {
  const event = {
    time:
      new Date().toISOString(),

    type,

    actor,

    message
  };

  state.events.push(event);

  if (
    state.events.length >
    250
  ) {
    state.events.shift();
  }

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

async function runTask(task) {
  const dbTask =
    await createTask(task);

  state.taskId =
    dbTask.id;

  state.task = task;

  state.status =
    "running";

  state.cycle = 0;

  state.awaitingOwner =
    false;

  state.ownerDecision =
    null;

  pushEvent(
    "task",
    "owner",
    task
  );

  let managerInstruction = "";

  while (
    state.cycle <
    MAX_CYCLES
  ) {
    if (
      state.ownerDecision ===
      "stop"
    ) {
      state.status =
        "stopped";

      await updateTask(
        state.taskId,
        {
          status: "stopped"
        }
      );

      pushEvent(
        "owner_stop",
        "owner",
        "Owner stopped execution."
      );

      return;
    }

    state.ownerDecision =
      null;

    state.cycle++;

    await updateTask(
      state.taskId,
      {
        cycle: state.cycle
      }
    );

    state.workerStatus =
      "working";

    pushEvent(
      "cycle",
      "system",
      `Starting cycle ${state.cycle}/${MAX_CYCLES}`
    );

    const worker =
      await runWorker({
        task,
        managerInstruction,
        cycle:
          state.cycle,

        onTool:
          async (
            name,
            args,
            step
          ) => {
            pushEvent(
              "tool",
              "worker",
              `${name} ${JSON.stringify(args)}`
            );
          },

        onText:
          async text => {
            state.workerMessage =
              text;

            pushEvent(
              "worker",
              "worker",
              text.slice(0, 5000)
            );
          }
      });

    state.workerStatus =
      "waiting_review";

    if (!worker.text) {
      state.workerMessage =
        "Worker produced no report.";
    } else {
      state.workerMessage =
        worker.text;
    }

    state.managerStatus =
      "reviewing";

    const review =
      await reviewWorker({
        task,

        workerReport:
          state.workerMessage,

        cycle:
          state.cycle
      });

    state.managerMessage =
      review.message;

    state.managerStatus =
      "idle";

    pushEvent(
      "manager",
      "manager",
      `${review.decision}: ${review.message}`
    );

    await addDecision(
      state.taskId,
      "manager",
      review.decision,
      review.message
    );

    if (
      review.decision ===
      "PASS"
    ) {
      state.status =
        "completed";

      await updateTask(
        state.taskId,
        {
          status:
            "completed",

          result:
            state.workerMessage,

          completed_at:
            new Date().toISOString()
        }
      );

      pushEvent(
        "completed",
        "manager",
        review.message
      );

      /*
       * Save a concise durable memory.
       */
      try {
        await memorySave({
          scope: "task",
          memory_key:
            `task-${state.taskId}`,

          content:
            `Task: ${task}\n\nResult: ${state.workerMessage}\n\nManager: ${review.message}`,

          importance: 6,

          tags: [
            "completed-task"
          ]
        });
      } catch (error) {
        pushEvent(
          "memory_error",
          "system",
          error.message
        );
      }

      return;
    }

    if (
      review.decision ===
      "PAUSE"
    ) {
      state.status =
        "paused";

      await updateTask(
        state.taskId,
        {
          status: "paused"
        }
      );

      pushEvent(
        "paused",
        "manager",
        review.message
      );

      return;
    }

    if (
      review.decision ===
      "OWNER_INPUT"
    ) {
      state.status =
        "awaiting_owner";

      state.awaitingOwner =
        true;

      await updateTask(
        state.taskId,
        {
          status:
            "awaiting_owner"
        }
      );

      pushEvent(
        "owner_input",
        "manager",
        review.message
      );

      return;
    }

    /*
     * ASK_WORKER / REWORK
     *
     * Give the Worker the Manager's
     * instruction on the next cycle.
     */
    managerInstruction =
      review.message;

    pushEvent(
      "manager_instruction",
      "manager",
      managerInstruction
    );
  }

  /*
   * Reached maximum cycles.
   * Do NOT continue automatically.
   */
  state.status =
    "awaiting_owner";

  state.awaitingOwner =
    true;

  await updateTask(
    state.taskId,
    {
      status:
        "awaiting_owner"
    }
  );

  pushEvent(
    "cycle_limit",
    "manager",
    `Reached ${MAX_CYCLES} cycles. Continue for another ${MAX_CYCLES} cycles?`
  );
}

app.get(
  "/api/state",
  (req, res) => {
    res.json({
      ...state,

      maxCycles:
        MAX_CYCLES
    });
  }
);

app.post(
  "/api/task",
  async (req, res) => {
    const task =
      String(
        req.body?.task || ""
      ).trim();

    if (!task) {
      return res
        .status(400)
        .json({
          error:
            "task required"
        });
    }

    if (
      state.status ===
      "running"
    ) {
      return res
        .status(409)
        .json({
          error:
            "A task is already running."
        });
    }

    /*
     * Reset runtime state.
     */
    state.taskId = null;
    state.task = task;
    state.status =
      "starting";
    state.cycle = 0;
    state.awaitingOwner =
      false;
    state.ownerDecision =
      null;
    state.workerStatus =
      "idle";
    state.managerStatus =
      "idle";
    state.workerMessage =
      "";
    state.managerMessage =
      "";
    state.events = [];

    runTask(task).catch(
      async error => {
        console.error(
          error
        );

        state.status =
          "error";

        state.awaitingOwner =
          false;

        pushEvent(
          "error",
          "system",
          error.message
        );

        if (
          state.taskId
        ) {
          await updateTask(
            state.taskId,
            {
              status:
                "error",

              result:
                error.stack
            }
          ).catch(
            console.error
          );
        }
      }
    );

    res.json({
      ok: true
    });
  }
);

app.post(
  "/api/owner/decision",
  async (req, res) => {
    const decision =
      req.body?.decision;

    if (
      ![
        "continue",
        "stop"
      ].includes(
        decision
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            "decision must be continue or stop"
        });
    }

    if (
      !state.awaitingOwner
    ) {
      return res
        .status(409)
        .json({
          error:
            "No Owner decision is currently required."
        });
    }

    state.awaitingOwner =
      false;

    state.ownerDecision =
      decision;

    await addDecision(
      state.taskId,
      "owner",
      decision
    );

    if (
      decision ===
      "stop"
    ) {
      state.status =
        "stopped";

      await updateTask(
        state.taskId,
        {
          status:
            "stopped"
        }
      );

      pushEvent(
        "owner_decision",
        "owner",
        "Owner stopped the task."
      );

      return res.json({
        ok: true
      });
    }

    /*
     * Continue another MAX_CYCLES.
     *
     * Important:
     * Reset cycle budget.
     */
    state.cycle = 0;

    state.status =
      "running";

    await updateTask(
      state.taskId,
      {
        status:
          "running",

        cycle: 0
      }
    );

    pushEvent(
      "owner_decision",
      "owner",
      `Owner approved another ${MAX_CYCLES}-cycle block.`
    );

    /*
     * Continue in background.
     */
    runTaskContinuation().catch(
      console.error
    );

    res.json({
      ok: true
    });
  }
);

async function runTaskContinuation() {
  /*
   * Continue using the existing task.
   *
   * This duplicates the execution loop
   * intentionally so Owner approval does
   * not create a new task.
   */
  const task =
    state.task;

  let managerInstruction =
    state.managerMessage ||
    "";

  while (
    state.cycle <
    MAX_CYCLES
  ) {
    state.cycle++;

    await updateTask(
      state.taskId,
      {
        cycle:
          state.cycle
      }
    );

    const worker =
      await runWorker({
        task,
        managerInstruction,
        cycle:
          state.cycle,

        onTool:
          async (
            name,
            args
          ) => {
            pushEvent(
              "tool",
              "worker",
              `${name} ${JSON.stringify(args)}`
            );
          },

        onText:
          async text => {
            state.workerMessage =
              text;

            pushEvent(
              "worker",
              "worker",
              text.slice(0, 5000)
            );
          }
      });

    state.workerMessage =
      worker.text;

    const review =
      await reviewWorker({
        task,

        workerReport:
          worker.text,

        cycle:
          state.cycle
      });

    state.managerMessage =
      review.message;

    pushEvent(
      "manager",
      "manager",
      `${review.decision}: ${review.message}`
    );

    await addDecision(
      state.taskId,
      "manager",
      review.decision,
      review.message
    );

    if (
      review.decision ===
      "PASS"
    ) {
      state.status =
        "completed";

      await updateTask(
        state.taskId,
        {
          status:
            "completed",

          result:
            worker.text,

          completed_at:
            new Date().toISOString()
        }
      );

      pushEvent(
        "completed",
        "manager",
        review.message
      );

      return;
    }

    if (
      review.decision ===
      "PAUSE"
    ) {
      state.status =
        "paused";

      await updateTask(
        state.taskId,
        {
          status:
            "paused"
        }
      );

      return;
    }

    if (
      review.decision ===
      "OWNER_INPUT"
    ) {
      state.status =
        "awaiting_owner";

      state.awaitingOwner =
        true;

      await updateTask(
        state.taskId,
        {
          status:
            "awaiting_owner"
        }
      );

      return;
    }

    managerInstruction =
      review.message;
  }

  state.status =
    "awaiting_owner";

  state.awaitingOwner =
    true;

  await updateTask(
    state.taskId,
    {
      status:
        "awaiting_owner"
    }
  );

  pushEvent(
    "cycle_limit",
    "manager",
    `Reached ${MAX_CYCLES} cycles again. Continue for another ${MAX_CYCLES} cycles?`
  );
}

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      model:
        process.env.GROQ_MODEL ||
        "openai/gpt-oss-120b",

      supabase:
        Boolean(
          process.env.SUPABASE_URL
        )
    });
  }
);

async function start() {
  await fs.mkdir(
    WORKSPACE,
    {
      recursive: true
    }
  );

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `AI Organization v3 listening on ${PORT}`
      );

      console.log(
        `Model: ${
          process.env.GROQ_MODEL ||
          "openai/gpt-oss-120b"
        }`
      );

      console.log(
        `Workspace: ${WORKSPACE}`
      );
    }
  );
}

start().catch(
  console.error
);