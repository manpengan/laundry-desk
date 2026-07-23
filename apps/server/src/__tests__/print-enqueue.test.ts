/**
 * M2 print: enqueue + process (XP-58 ESC/POS) + retry/reprint + jobs.list over memory store + bus.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryPrintJobStore } from "../print/memory-store.js";
import type { PrintJobStore } from "../print/types.js";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const CLERK: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["order_write", "staff_read"]),
});

const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FIXED_NOW = () => 1_721_606_400;
const FIXED_JOB_ID = () => "ffffffff-ffff-4fff-8fff-ffffffffffff";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";

function sequentialIds(ids: readonly string[]): () => string {
  let i = 0;
  return () => {
    const id = ids[i];
    if (id === undefined) {
      throw new Error(`test id pool exhausted at index ${i}`);
    }
    i += 1;
    return id;
  };
}

function buildBus(
  printStore: PrintJobStore = createMemoryPrintJobStore(),
  options: Readonly<{ newId?: () => string }> = {},
) {
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    print: Object.freeze({
      store: printStore,
      now: FIXED_NOW,
      newId: options.newId ?? FIXED_JOB_ID,
    }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, printStore };
}

test("command + query registries include print skeleton names", () => {
  const { registry, queryRegistry } = buildBus();
  assert.ok(registry.names().includes("print.ticket.enqueue"));
  assert.ok(registry.names().includes("print.ticket.process"));
  assert.ok(registry.names().includes("print.ticket.retry"));
  assert.ok(registry.names().includes("print.ticket.reprint"));
  assert.ok(queryRegistry.names().includes("print.jobs.list"));
});

test("print.ticket.enqueue returns queued job and list sees it", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();

  const enqueued = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.enqueue",
    {
      order_id: ORDER_ID,
      ticket_no: "20260722-0001",
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );

  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  if (!enqueued.ok) return;
  assert.equal(enqueued.data.execution, "executed");
  const data = enqueued.data.result as {
    job_id: string;
    status: string;
    kind: string;
    order_id: string;
    ticket_no: string;
  };
  assert.equal(data.job_id, FIXED_JOB_ID());
  assert.equal(data.status, "queued");
  assert.equal(data.kind, "xp58");
  assert.equal(data.order_id, ORDER_ID);
  assert.equal(data.ticket_no, "20260722-0001");

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "print.jobs.list",
    {},
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as {
    jobs: readonly {
      job_id: string;
      status: string;
      kind: string;
      order_id: string;
      ticket_no: string;
      created_at: number;
      updated_at: number;
    }[];
  };
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0]?.job_id, data.job_id);
  assert.equal(body.jobs[0]?.status, "queued");
  assert.equal(body.jobs[0]?.kind, "xp58");
  assert.equal(body.jobs[0]?.created_at, FIXED_NOW());
  assert.equal(body.jobs[0]?.updated_at, FIXED_NOW());
});

test("print.ticket.enqueue accepts explicit kind", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.enqueue",
    {
      order_id: ORDER_ID,
      ticket_no: "T-99",
      kind: "gp3120",
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const data = result.data.result as { kind: string; status: string };
  assert.equal(data.kind, "gp3120");
  assert.equal(data.status, "queued");
});

test("print.jobs.list returns newest first and respects limit", async () => {
  const printStore = createMemoryPrintJobStore();
  await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "old",
    kind: "xp58",
    job_id: "11111111-1111-4111-8111-111111111111",
    now: 100,
  });
  await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "new",
    kind: "dl206",
    job_id: "22222222-2222-4222-8222-222222222222",
    now: 200,
  });

  const { queryRegistry } = buildBus(printStore);
  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "print.jobs.list",
    { limit: 1 },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as {
    jobs: readonly { ticket_no: string; job_id: string }[];
  };
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0]?.ticket_no, "new");
});

test("print.ticket.enqueue without order_write is PERMISSION_DENIED", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const noWrite: ActorContext = Object.freeze({
    ...CLERK,
    permissions: Object.freeze(["staff_read"]),
  });
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.enqueue",
    {
      order_id: ORDER_ID,
      ticket_no: "x",
    },
    { registry, actor: noWrite, chainHooks, pendingStore },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PERMISSION_DENIED");
});

test("print.ticket.enqueue invalid input is VALIDATION_FAILED", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.enqueue",
    {
      order_id: "not-a-uuid",
      ticket_no: "x",
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "VALIDATION_FAILED");
});

test("enqueue → process → list shows done + payload_bytes", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();

  const enqueued = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.enqueue",
    {
      order_id: ORDER_ID,
      ticket_no: "20260722-0001",
      kind: "xp58",
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  if (!enqueued.ok) return;
  const enq = enqueued.data.result as { job_id: string; status: string };
  assert.equal(enq.status, "queued");

  const processed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.process",
    { job_id: enq.job_id },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(processed.ok, true, JSON.stringify(processed));
  if (!processed.ok) return;
  const proc = processed.data.result as {
    job_id: string;
    status: string;
    payload_bytes: number;
  };
  assert.equal(proc.status, "done");
  assert.ok(proc.payload_bytes > 0);

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "print.jobs.list",
    {},
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as {
    jobs: readonly {
      job_id: string;
      status: string;
      payload_bytes?: number;
    }[];
  };
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0]?.status, "done");
  assert.equal(body.jobs[0]?.payload_bytes, proc.payload_bytes);
});

test("print.ticket.process rejects non-xp58 kind", async () => {
  const printStore = createMemoryPrintJobStore();
  await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "T",
    kind: "dl206",
    job_id: FIXED_JOB_ID(),
    now: FIXED_NOW(),
  });
  const { registry, chainHooks, pendingStore } = buildBus(printStore);
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.process",
    { job_id: FIXED_JOB_ID() },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "VALIDATION_FAILED");
});

test("print.ticket.process missing job is RESOURCE_UNAVAILABLE", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.process",
    { job_id: "00000000-0000-4000-8000-000000000099" },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
});

test("failed job → retry enqueues new job, auto-processes xp58 to done, source stays failed", async () => {
  const printStore = createMemoryPrintJobStore();
  const source = await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "20260722-RETRY",
    kind: "xp58",
    job_id: ID_A,
    now: FIXED_NOW(),
  });
  await printStore.transition(source.job_id, "printing", { now: FIXED_NOW() });
  await printStore.transition(source.job_id, "failed", {
    now: FIXED_NOW() + 1,
    error: "printer offline",
  });

  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus(printStore, {
    newId: sequentialIds([ID_B]),
  });

  const retried = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.retry",
    { job_id: ID_A },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(retried.ok, true, JSON.stringify(retried));
  if (!retried.ok) return;
  const data = retried.data.result as {
    job_id: string;
    status: string;
    kind: string;
    order_id: string;
    ticket_no: string;
    payload_bytes?: number;
  };
  assert.equal(data.job_id, ID_B);
  assert.notEqual(data.job_id, ID_A);
  assert.equal(data.status, "done");
  assert.equal(data.kind, "xp58");
  assert.equal(data.order_id, ORDER_ID);
  assert.equal(data.ticket_no, "20260722-RETRY");
  assert.ok(typeof data.payload_bytes === "number" && data.payload_bytes > 0);

  const sourceAfter = await printStore.get(ID_A);
  assert.equal(sourceAfter?.status, "failed");
  assert.equal(sourceAfter?.error, "printer offline");

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "print.jobs.list",
    {},
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as {
    jobs: readonly { job_id: string; status: string }[];
  };
  assert.ok(body.jobs.length >= 2);
  const byId = new Map(body.jobs.map((j) => [j.job_id, j.status]));
  assert.equal(byId.get(ID_A), "failed");
  assert.equal(byId.get(ID_B), "done");
});

test("done job → reprint enqueues new job and auto-processes xp58", async () => {
  const printStore = createMemoryPrintJobStore();
  const { registry, chainHooks, pendingStore } = buildBus(printStore, {
    newId: sequentialIds([ID_A, ID_B]),
  });

  const enqueued = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.enqueue",
    { order_id: ORDER_ID, ticket_no: "20260722-REPRINT", kind: "xp58" },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(enqueued.ok, true, JSON.stringify(enqueued));
  if (!enqueued.ok) return;
  const firstId = (enqueued.data.result as { job_id: string }).job_id;
  assert.equal(firstId, ID_A);

  const processed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.process",
    { job_id: firstId },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(processed.ok, true, JSON.stringify(processed));
  if (!processed.ok) return;
  assert.equal((processed.data.result as { status: string }).status, "done");

  const reprinted = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.reprint",
    { job_id: firstId },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(reprinted.ok, true, JSON.stringify(reprinted));
  if (!reprinted.ok) return;
  const data = reprinted.data.result as {
    job_id: string;
    status: string;
    ticket_no: string;
    payload_bytes?: number;
  };
  assert.equal(data.job_id, ID_B);
  assert.equal(data.status, "done");
  assert.equal(data.ticket_no, "20260722-REPRINT");
  assert.ok(typeof data.payload_bytes === "number" && data.payload_bytes > 0);

  const original = await printStore.get(ID_A);
  assert.equal(original?.status, "done");
});

test("retry rejects non-failed source; reprint rejects non-done source", async () => {
  const printStore = createMemoryPrintJobStore();
  await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "queued",
    kind: "xp58",
    job_id: ID_A,
    now: FIXED_NOW(),
  });
  await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "done-src",
    kind: "xp58",
    job_id: ID_B,
    now: FIXED_NOW(),
  });
  await printStore.transition(ID_B, "printing", { now: FIXED_NOW() });
  await printStore.transition(ID_B, "done", { now: FIXED_NOW() + 1, payload_bytes: 10 });

  const { registry, chainHooks, pendingStore } = buildBus(printStore, {
    newId: sequentialIds([ID_C]),
  });

  const retryQueued = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.retry",
    { job_id: ID_A },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(retryQueued.ok, false);
  if (retryQueued.ok) return;
  assert.equal(retryQueued.error.code, "VALIDATION_FAILED");

  const retryDone = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.retry",
    { job_id: ID_B },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(retryDone.ok, false);
  if (retryDone.ok) return;
  assert.equal(retryDone.error.code, "VALIDATION_FAILED");

  const reprintQueued = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.reprint",
    { job_id: ID_A },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(reprintQueued.ok, false);
  if (reprintQueued.ok) return;
  assert.equal(reprintQueued.error.code, "VALIDATION_FAILED");
});

test("retry / reprint missing job is RESOURCE_UNAVAILABLE", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  for (const name of ["print.ticket.retry", "print.ticket.reprint"] as const) {
    const result = await executeCommand(
      new FakeSqlClient(),
      TENANT,
      name,
      { job_id: "00000000-0000-4000-8000-000000000099" },
      { registry, actor: CLERK, chainHooks, pendingStore },
    );
    assert.equal(result.ok, false, name);
    if (result.ok) return;
    assert.equal(result.error.code, "RESOURCE_UNAVAILABLE", name);
  }
});

test("retry on non-xp58 leaves new job queued (no auto-process)", async () => {
  const printStore = createMemoryPrintJobStore();
  await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "DL",
    kind: "dl206",
    job_id: ID_A,
    now: FIXED_NOW(),
  });
  await printStore.transition(ID_A, "printing", { now: FIXED_NOW() });
  await printStore.transition(ID_A, "failed", { now: FIXED_NOW() + 1, error: "edge offline" });

  const { registry, chainHooks, pendingStore } = buildBus(printStore, {
    newId: sequentialIds([ID_B]),
  });
  const retried = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.retry",
    { job_id: ID_A },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(retried.ok, true, JSON.stringify(retried));
  if (!retried.ok) return;
  const data = retried.data.result as { job_id: string; status: string; kind: string };
  assert.equal(data.job_id, ID_B);
  assert.equal(data.status, "queued");
  assert.equal(data.kind, "dl206");
});

test("retry without order_write is PERMISSION_DENIED", async () => {
  const printStore = createMemoryPrintJobStore();
  await printStore.enqueue({
    order_id: ORDER_ID,
    ticket_no: "x",
    kind: "xp58",
    job_id: ID_A,
    now: FIXED_NOW(),
  });
  await printStore.transition(ID_A, "printing", { now: FIXED_NOW() });
  await printStore.transition(ID_A, "failed", { now: FIXED_NOW() + 1, error: "x" });

  const { registry, chainHooks, pendingStore } = buildBus(printStore, {
    newId: sequentialIds([ID_B]),
  });
  const noWrite: ActorContext = Object.freeze({
    ...CLERK,
    permissions: Object.freeze(["staff_read"]),
  });
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "print.ticket.retry",
    { job_id: ID_A },
    { registry, actor: noWrite, chainHooks, pendingStore },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PERMISSION_DENIED");
});
