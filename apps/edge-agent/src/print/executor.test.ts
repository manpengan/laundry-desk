import assert from "node:assert/strict";
import test from "node:test";

import { createMockSpool, enqueue as mockEnqueue } from "./mock-spool.js";
import { DEFAULT_SAMPLE_TICKET, executeJob } from "./executor.js";
import { createPrintJobStore, enqueuePrintJob, listPrintJobStatus } from "./print-jobs.js";
import { createMockUsbPort } from "./usb-port.js";

const NONCE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("executeJob happy path: done + non-empty ESC/POS + succeeded receipt", async () => {
  let store = createPrintJobStore();
  let spool = createMockSpool();
  const enq = enqueuePrintJob(store, "xp58", 1000, NONCE);
  store = enq.store;
  const mock = mockEnqueue(spool, "xp58", 1000);
  spool = mock.spool;

  const result = await executeJob(
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

test("executeJob failed keeps error and failed receipt", async () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const result = await executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
    forceError: "spool offline",
    now: 1,
    at: new Date("2026-07-21T10:00:00.000Z"),
  });

  assert.equal(result.job.status, "failed");
  assert.equal(result.job.error, "spool offline");
  assert.equal(result.receiptPayload.result, "failed");
  assert.equal(listPrintJobStatus(result.store)[0]?.error, "spool offline");
});

test("executeJob rejects non-queued jobs", async () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 1, NONCE);
  const once = await executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
    now: 1,
  });
  await assert.rejects(
    () => executeJob(once.store, once.spool, job.id, DEFAULT_SAMPLE_TICKET),
    /queued/,
  );
});

test("executeJob mock USB success path", async () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 10, NONCE);
  const usbPort = createMockUsbPort();
  const result = await executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
    now: 10,
    usbPort,
    at: new Date("2026-07-21T10:00:00.000Z"),
  });
  assert.equal(result.job.status, "done");
  assert.equal(result.receiptPayload.result, "succeeded");
  assert.ok(result.bytes.byteLength > 0);
});

test("executeJob mock USB fail → failed status", async () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 20, NONCE);
  const usbPort = createMockUsbPort({ failWith: "USB device not found" });
  const result = await executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
    now: 20,
    usbPort,
    at: new Date("2026-07-21T10:00:00.000Z"),
  });
  assert.equal(result.job.status, "failed");
  assert.equal(result.job.error, "USB device not found");
  assert.equal(result.receiptPayload.result, "failed");
});

test("executeJob USB timeout fail", async () => {
  const { store, job } = enqueuePrintJob(createPrintJobStore(), "xp58", 30, NONCE);
  const usbPort = createMockUsbPort({ delayMs: 200 });
  const result = await executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
    now: 30,
    timeoutMs: 30,
    usbPort,
    at: new Date("2026-07-21T10:00:00.000Z"),
  });
  assert.equal(result.job.status, "failed");
  assert.match(result.job.error ?? "", /timed out after 30ms/);
  assert.equal(result.receiptPayload.result, "failed");
});

for (const kind of ["dl206", "gp3120"] as const) {
  test(`executeJob dispatches ${kind} through its family driver`, async () => {
    const { store, job } = enqueuePrintJob(createPrintJobStore(), kind, 40, NONCE);
    const result = await executeJob(store, createMockSpool(), job.id, DEFAULT_SAMPLE_TICKET, {
      now: 40,
      usbPort: createMockUsbPort(),
    });
    assert.equal(result.job.status, "done");
    assert.ok(result.bytes.byteLength > 0);
    assert.equal(result.receiptPayload.result, "succeeded");
  });
}
