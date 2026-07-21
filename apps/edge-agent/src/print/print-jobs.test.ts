import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionReceiptPayload,
  createPrintJobStore,
  enqueuePrintJob,
  listPrintJobStatus,
  transitionPrintJob,
} from "./print-jobs.js";

const NONCE = "9dfc4424-9b9a-4e52-baaa-c02868f8e7de";

test("job lifecycle queued → printing → done", () => {
  const empty = createPrintJobStore();
  const { store, job } = enqueuePrintJob(empty, "xp58", 1000, NONCE);
  assert.equal(job.status, "queued");
  assert.equal(job.seq, 1);
  assert.equal(job.ticketNonce, NONCE);

  const printing = transitionPrintJob(store, job.id, "printing", { now: 2000 });
  assert.equal(printing.jobs[0]?.status, "printing");

  const done = transitionPrintJob(printing, job.id, "done", { now: 3000 });
  assert.equal(done.jobs[0]?.status, "done");
  assert.equal(done.jobs[0]?.updatedAt, 3000);
});

test("failed job keeps error text", () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const printing = transitionPrintJob(store, job.id, "printing", { now: 2 });
  const failed = transitionPrintJob(printing, job.id, "failed", {
    error: "spool offline",
    now: 3,
  });
  assert.equal(failed.jobs[0]?.status, "failed");
  assert.equal(failed.jobs[0]?.error, "spool offline");
});

test("listPrintJobStatus is status-only (no ticketNonce)", () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const views = listPrintJobStatus(store);
  assert.equal(views.length, 1);
  assert.equal(views[0]?.id, job.id);
  assert.equal(views[0]?.status, "queued");
  assert.equal("ticketNonce" in (views[0] as object), false);
});

test("buildExecutionReceiptPayload for done and failed", () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const printing = transitionPrintJob(store, job.id, "printing", { now: 2 });
  const doneStore = transitionPrintJob(printing, job.id, "done", { now: 3 });
  const doneJob = doneStore.jobs[0]!;
  const at = new Date("2026-07-21T01:02:04.000Z");
  const payload = buildExecutionReceiptPayload(doneJob, at);
  assert.equal(payload.ticket_nonce, NONCE);
  assert.equal(payload.result, "succeeded");
  assert.equal(payload.seq, 1);
  assert.equal(payload.at, "2026-07-21T01:02:04.000Z");

  const { store: s2, job: j2 } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const p2 = transitionPrintJob(s2, j2.id, "printing");
  const f2 = transitionPrintJob(p2, j2.id, "failed", { error: "knife jam" });
  const failPayload = buildExecutionReceiptPayload(f2.jobs[0]!, at);
  assert.equal(failPayload.result, "failed");
});

test("receipt rejects non-terminal jobs", () => {
  const { job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  assert.throws(() => buildExecutionReceiptPayload(job), /terminal/);
});
