/**
 * Unit tests for MemoryPrintJobStore status transitions.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryPrintJobStore } from "./memory-store.js";

const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("enqueue creates queued job with timestamps", async () => {
  const store = createMemoryPrintJobStore();
  const job = await store.enqueue({
    order_id: ORDER_ID,
    ticket_no: "20260722-0001",
    kind: "xp58",
    job_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    now: 1_000,
  });
  assert.equal(job.status, "queued");
  assert.equal(job.created_at, 1_000);
  assert.equal(job.updated_at, 1_000);

  const listed = await store.list(10);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.job_id, job.job_id);
});

test("transition follows queued → printing → done", async () => {
  const store = createMemoryPrintJobStore();
  const job = await store.enqueue({
    order_id: ORDER_ID,
    ticket_no: "T",
    kind: "dl206",
    now: 10,
  });
  const printing = await store.transition(job.job_id, "printing", { now: 20 });
  assert.equal(printing.status, "printing");
  assert.equal(printing.updated_at, 20);
  const done = await store.transition(job.job_id, "done", { now: 30 });
  assert.equal(done.status, "done");
  assert.equal(done.updated_at, 30);
});

test("transition to failed requires error and rejects illegal edges", async () => {
  const store = createMemoryPrintJobStore();
  const job = await store.enqueue({
    order_id: ORDER_ID,
    ticket_no: "T",
    kind: "gp3120",
  });
  await assert.rejects(() => store.transition(job.job_id, "done"), /cannot move/);
  await store.transition(job.job_id, "printing");
  await assert.rejects(() => store.transition(job.job_id, "failed"), /error/);
  const failed = await store.transition(job.job_id, "failed", { error: "usb offline" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "usb offline");
  await assert.rejects(() => store.transition(job.job_id, "printing"), /terminal/);
});
