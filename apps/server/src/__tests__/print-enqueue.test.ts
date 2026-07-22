/**
 * M2 skeleton: print.ticket.enqueue + print.jobs.list over memory store + bus.
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

function buildBus(printStore = createMemoryPrintJobStore()) {
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    print: Object.freeze({
      store: printStore,
      now: FIXED_NOW,
      newId: FIXED_JOB_ID,
    }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, printStore };
}

test("command + query registries include print skeleton names", () => {
  const { registry, queryRegistry } = buildBus();
  assert.ok(registry.names().includes("print.ticket.enqueue"));
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
