/**
 * Unit tests for XP-58 process path over memory store.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryPrintJobStore } from "./memory-store.js";
import { processXp58PrintJob } from "./process-xp58.js";

const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("processXp58PrintJob transitions queued → done with payload_bytes", async () => {
  const store = createMemoryPrintJobStore();
  const job = await store.enqueue({
    order_id: ORDER_ID,
    ticket_no: "20260722-0001",
    kind: "xp58",
    job_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    now: 1000,
  });

  const result = await processXp58PrintJob(store, job.job_id, { now: 2000 });
  assert.equal(result.job.status, "done");
  assert.ok(result.payload_bytes > 0);
  assert.equal(result.job.payload_bytes, result.payload_bytes);
  assert.equal(result.job.updated_at, 2001);

  const listed = await store.list(10);
  assert.equal(listed[0]?.status, "done");
  assert.equal(listed[0]?.payload_bytes, result.payload_bytes);
});

test("processXp58PrintJob rejects non-xp58 kind without mutating", async () => {
  const store = createMemoryPrintJobStore();
  const job = await store.enqueue({
    order_id: ORDER_ID,
    ticket_no: "T",
    kind: "dl206",
    now: 10,
  });
  await assert.rejects(() => processXp58PrintJob(store, job.job_id), /not xp58/);
  const again = await store.get(job.job_id);
  assert.equal(again?.status, "queued");
});

test("processXp58PrintJob rejects missing job", async () => {
  const store = createMemoryPrintJobStore();
  await assert.rejects(
    () => processXp58PrintJob(store, "00000000-0000-4000-8000-000000000099"),
    /not found/,
  );
});
