import assert from "node:assert/strict";
import test from "node:test";

import { createMockSpool, enqueue as mockEnqueue } from "./mock-spool.js";
import { DEFAULT_SAMPLE_TICKET, executeJob } from "./executor.js";
import { createPrintJobStore, enqueuePrintJob, listPrintJobStatus } from "./print-jobs.js";

const NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("executeJob happy path: done + non-empty ESC/POS + succeeded receipt", () => {
  let store = createPrintJobStore();
  let spool = createMockSpool();
  const enq = enqueuePrintJob(store, "xp58", 1000, NONCE);
  store = enq.store;
  const mock = mockEnqueue(spool, "xp58", 1000);
  spool = mock.spool;

  const result = executeJob(
    store,
    spool,
    enq.job.id,
    DEFAULT_SAMPLE_TICKET,
    { now: 1000, at: new Date("2026-07-21T10:00:00.000Z") },
    mock.job.id,
  );

  assert.equal(result.job.status, "done");
  assert.ok(result.bytes.byteLength > 0);
  assert.equal(result.receiptPayload.result, "succeeded");
  assert.equal(result.receiptPayload.ticket_nonce, NONCE);
  assert.equal(result.receiptPayload.seq, 1);
  assert.equal(result.spool.jobs[0]?.status, "done");
  assert.equal(listPrintJobStatus(result.store)[0]?.status, "done");
});

test("executeJob failed keeps error and failed receipt", () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const result = executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
    forceError: "spool offline",
    now: 1,
    at: new Date("2026-07-21T10:00:00.000Z"),
  });

  assert.equal(result.job.status, "failed");
  assert.equal(result.job.error, "spool offline");
  assert.equal(result.receiptPayload.result, "failed");
  assert.equal(listPrintJobStatus(result.store)[0]?.error, "spool offline");
});

test("executeJob rejects non-queued jobs", () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const once = executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
    now: 1,
  });
  assert.throws(() => executeJob(once.store, once.spool, job.id, DEFAULT_SAMPLE_TICKET), /queued/);
});
