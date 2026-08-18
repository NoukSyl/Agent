// Kept as a compatibility shim for older imports. The project now uses two
// real Worker agents instead of a role-played Manager agent.
const { runWorkerB, WORKER_B_MODEL } = require("./worker");

async function reviewWorker(args) {
  return runWorkerB(args);
}

module.exports = { reviewWorker, WORKER_B_MODEL };
