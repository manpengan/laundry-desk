import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createFileSpool } from "./file-spool.js";
import { createMemoryPrintJobStore } from "./memory-store.js";
import type { PrintJobStore } from "./types.js";
import { createPrintWorkerController } from "./worker-controller.js";

const JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function claimingMemoryStore(): PrintJobStore {
  const base = createMemoryPrintJobStore();
  return Object.freeze({
    enqueue: (input) => base.enqueue(input),
    list: (limit) => base.list(limit),
    get: (jobId) => base.get(jobId),
    transition: (jobId, status, options) => base.transition(jobId, status, options),
    claimNext: async (input) => {
      const job = (await base.list(50)).find((candidate) => candidate.status === "queued");
      if (job === undefined) return null;
      const now = input.now ?? Math.floor(Date.now() / 1_000);
      await base.transition(job.job_id, "printing", { now });
      return Object.freeze({
        job_id: job.job_id,
        kind: job.kind,
        order_id: job.order_id,
        ticket_no: job.ticket_no,
        attempt_count: 1,
        lease_until: now + (input.lease_seconds ?? 30),
        worker_id: input.worker_id,
      });
    },
  });
}

test("runNow drains queued jobs and reports bounded spool health", async () => {
  const store = claimingMemoryStore();
  const root = await mkdtemp(join(tmpdir(), "laundry-worker-controller-"));
  const spool = await createFileSpool({ rootPath: join(root, "spool") });
  let now = 100;
  await store.enqueue({
    job_id: JOB_ID,
    order_id: ORDER_ID,
    ticket_no: "T-100",
    kind: "xp58",
    now,
  });
  const controller = createPrintWorkerController({
    store,
    spool,
    workerId: "test-worker",
    now: () => ++now,
  });

  await controller.runNow();

  assert.equal((await store.get(JOB_ID))?.status, "done");
  const status = controller.status();
  assert.equal(status.state, "stopped");
  assert.equal(status.worker_id, "test-worker");
  assert.equal(status.processed_jobs, 1);
  assert.equal(status.failed_jobs, 0);
  assert.equal(typeof status.last_cycle_at, "number");
  assert.equal(status.last_error_code, null);
  assert.equal(status.spool_artifacts, 1);
  assert.ok(status.spool_bytes > 0);
});

test("start and stop are idempotent and stop waits for the active cycle", async () => {
  const store = claimingMemoryStore();
  const root = await mkdtemp(join(tmpdir(), "laundry-worker-controller-"));
  const spool = await createFileSpool({ rootPath: join(root, "spool") });
  const controller = createPrintWorkerController({
    store,
    spool,
    workerId: "lifecycle-worker",
    pollIntervalMs: 60_000,
  });

  controller.start();
  controller.start();
  assert.equal(controller.status().state, "running");
  await controller.stop();
  await controller.stop();
  assert.equal(controller.status().state, "stopped");
  assert.equal(controller.status().last_error_code, null);
});
