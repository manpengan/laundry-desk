import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import { permissionsForAuthority } from "../bus/runtime.js";
import type { ActorContext, CommandHandler } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import type { LedgerPaymentRow, OrderStore } from "../order/types.js";
import { createMemoryPrintJobStore } from "../print/memory-store.js";
import { buildReconciliationCsv, escapeReconciliationCsvCell } from "../reconciliation/csv.js";
import {
  createReconciliationHandlers,
  resolveReconciliationBusinessDate,
} from "../reconciliation/handlers.js";
import { createMemoryReconciliationSource } from "../reconciliation/memory-source.js";
import { createPgReconciliationSource } from "../reconciliation/pg-source.js";
import type {
  ReconciliationHandlerDeps,
  ReconciliationReadInput,
  ReconciliationSnapshot,
} from "../reconciliation/types.js";
import { createMemoryShiftStore } from "../shift/memory-store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "10000000-0000-4000-8000-000000000001",
  storeId: "10000000-0000-4000-8000-000000000002",
  staffId: "10000000-0000-4000-8000-000000000003",
});
const ADMIN: ActorContext = Object.freeze({
  staffId: TENANT.staffId,
  deviceId: "10000000-0000-4000-8000-000000000004",
  via: "ui",
  permissions: Object.freeze(["accounting_read", "ledger_export", "edge_conflict_resolve"]),
});
const STAFF: ActorContext = Object.freeze({
  ...ADMIN,
  permissions: Object.freeze(["order_write"]),
});
const NOW = new Date("2026-07-30T20:30:00.000Z");

function emptySnapshot(businessDate: string): ReconciliationSnapshot {
  return Object.freeze({
    business_date: businessDate,
    orders: Object.freeze({
      count: 0,
      payable_cents: 0,
      paid_cents: 0,
      balance_cents: 0,
    }),
    ledger: Object.freeze({
      row_count: 0,
      gross_cents: 0,
      refund_cents: 0,
      net_cents: 0,
      difference_from_orders_cents: 0,
      buckets: Object.freeze([]),
    }),
    shift: null,
    print: Object.freeze({ total: 0, statuses: Object.freeze([]) }),
    edge_replay: Object.freeze({
      total: 0,
      conflict_count: 0,
      decisions: Object.freeze([]),
    }),
  });
}

function deps(
  onRead: (businessDate: string) => void = () => undefined,
  conflictExists = false,
): ReconciliationHandlerDeps {
  return Object.freeze({
    source: Object.freeze({
      readDay: async ({ businessDate }: ReconciliationReadInput) => {
        onRead(businessDate);
        return emptySnapshot(businessDate);
      },
    }),
    edgeConflicts: Object.freeze({
      hasDiscardableConflict: async () => conflictExists,
    }),
    timeZone: "Asia/Taipei",
    rolloverHour: 6,
    now: () => new Date(NOW),
  });
}

function handlerContext(parsed: unknown): Parameters<CommandHandler>[0] {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor: ADMIN,
    request: Object.freeze({
      name: "reconciliation.export",
      version: "0.1.0",
      input: parsed,
      dryRun: false,
    }),
    parsed,
  });
}

test("reconciliation query enforces metadata RBAC before opening a transaction", async () => {
  let reads = 0;
  const { queryRegistry } = createRegisteredM1Bus({
    reconciliation: deps(() => {
      reads += 1;
    }),
  });
  const client = new FakeSqlClient();
  const denied = await executeQuery(
    client,
    TENANT,
    "reconciliation.day.get",
    {},
    {
      registry: queryRegistry,
      actor: STAFF,
    },
  );
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "PERMISSION_DENIED");
  assert.equal(reads, 0);
  assert.deepEqual(client.queries, []);
});

test("runtime grants accounting and operational management only to administrators", () => {
  const admin = permissionsForAuthority({ role: "admin", is_privacy_admin: false });
  const staff = permissionsForAuthority({ role: "staff", is_privacy_admin: false });
  for (const permission of [
    "accounting_read",
    "ledger_export",
    "payment_refund",
    "shift_close",
    "print_manage",
    "audit_read",
    "edge_conflict_resolve",
  ]) {
    assert.ok(admin.includes(permission), permission);
    assert.equal(staff.includes(permission), false, permission);
  }
});

test("omitted business date uses the store timezone and rollover hour", async () => {
  let resolved = "";
  const { queryRegistry } = createRegisteredM1Bus({
    reconciliation: deps((businessDate) => {
      resolved = businessDate;
    }),
  });
  const client = new FakeSqlClient();
  const result = await executeQuery(
    client,
    TENANT,
    "reconciliation.day.get",
    {},
    { registry: queryRegistry, actor: ADMIN },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(client.sqlSequence()[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(resolved, "2026-07-30");
  if (result.ok) {
    assert.equal((result.data.result as { business_date: string }).business_date, resolved);
  }
  assert.equal(
    resolveReconciliationBusinessDate(undefined, {
      timeZone: "Asia/Taipei",
      rolloverHour: 6,
      now: () => new Date("2026-07-30T22:30:00.000Z"),
    }),
    "2026-07-31",
  );
  assert.throws(
    () =>
      resolveReconciliationBusinessDate("2026-02-30", {
        timeZone: "Asia/Taipei",
      }),
    { name: "HandlerCommandError" },
  );
});

test("memory reconciliation signs cross-day reversal references before bucket aggregation", async () => {
  const payment = (
    paymentId: string,
    kind: LedgerPaymentRow["kind"],
    refPaymentId: string | null,
    businessDate: string,
  ): LedgerPaymentRow =>
    Object.freeze({
      payment_id: paymentId,
      org_id: TENANT.orgId,
      store_id: TENANT.storeId,
      order_id: "10000000-0000-4000-8000-000000000009",
      method: "cash",
      amount_cents: 100,
      kind,
      ref_payment_id: refPaymentId,
      staff_id: TENANT.staffId,
      at: 1,
      note: null,
      business_date: businessDate,
    });
  const rows = Object.freeze([
    payment("pay-prior", "pay", null, "2026-07-29"),
    payment("refund-prior", "refund", "pay-prior", "2026-07-29"),
    payment("reverse-pay", "reversal", "pay-prior", "2026-07-30"),
    payment("reverse-refund", "reversal", "refund-prior", "2026-07-30"),
  ]);
  const orders: OrderStore = Object.freeze({
    insertOrder: async () => undefined,
    getOrder: async () => null,
    listGarments: async () => Object.freeze([]),
    applyPickup: async () => null,
    nextTicketSeq: async () => 1,
    listOrders: async () => Object.freeze([]),
    listPayments: async () => rows,
  });
  const printJobs = createMemoryPrintJobStore();
  await printJobs.enqueue({
    job_id: "target-day-print",
    order_id: "10000000-0000-4000-8000-000000000009",
    ticket_no: "T-1",
    kind: "xp58",
    now: Date.parse("2026-07-30T04:00:00.000Z") / 1_000,
  });
  for (let index = 0; index < 60; index += 1) {
    await printJobs.enqueue({
      job_id: `newer-print-${index}`,
      order_id: "10000000-0000-4000-8000-000000000009",
      ticket_no: `N-${index}`,
      kind: "xp58",
      now: Date.parse("2026-07-31T04:00:00.000Z") / 1_000,
    });
  }
  const result = await createMemoryReconciliationSource({
    orders,
    shifts: createMemoryShiftStore(),
    printJobs,
    timeZone: "Asia/Taipei",
  }).readDay({
    client: new FakeSqlClient(),
    tenant: TENANT,
    businessDate: "2026-07-30",
  });

  assert.equal(result.ledger.row_count, 2);
  assert.equal(result.ledger.gross_cents, 100);
  assert.equal(result.ledger.refund_cents, 100);
  assert.equal(result.ledger.net_cents, 0);
  assert.equal(result.print.total, 1);
  assert.deepEqual(result.ledger.buckets, [
    {
      method: "cash",
      kind: "reversal",
      row_count: 2,
      amount_cents: 200,
      net_cents: 0,
    },
  ]);
});

test("export is deterministic, hashed outside the CSV and audits only metadata", async () => {
  const handler = createReconciliationHandlers(deps())["reconciliation.export"];
  assert.ok(handler);
  const first = await handler(handlerContext({ format: "csv" }));
  const second = await handler(handlerContext({ format: "csv" }));
  assert.deepEqual(first.result, second.result);
  const result = first.result as {
    filename: string;
    content_sha256: string;
    csv: string;
  };
  assert.equal(result.filename, "reconciliation-2026-07-30.csv");
  assert.match(result.content_sha256, /^[0-9a-f]{64}$/u);
  assert.ok(result.csv.endsWith("\n"));
  assert.doesNotMatch(first.audit?.afterJson ?? "", /"csv"\s*:|section,key/iu);
  assert.equal(escapeReconciliationCsvCell(" =2+2"), '"\' =2+2"');
});

test("export reads and writes its audit inside one repeatable-read transaction", async () => {
  const bus = createRegisteredM1Bus({ reconciliation: deps() });
  const client = new FakeSqlClient();
  const result = await executeCommand(
    client,
    TENANT,
    "reconciliation.export",
    { format: "csv" },
    {
      registry: bus.registry,
      actor: ADMIN,
      chainHooks: Object.freeze({
        ...bus.chainHooks,
        checkPolicy: async () =>
          Object.freeze({
            ok: true as const,
            data: Object.freeze({ allowed: true as const }),
          }),
      }),
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(client.sqlSequence()[0], "BEGIN ISOLATION LEVEL REPEATABLE READ");
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
  assert.ok(client.sqlSequence().some((sql) => sql.includes("INSERT INTO audit_log")));
});

test("edge conflict discard fails closed and never mutates replay authority", async () => {
  const parsed = {
    queue_id: "10000000-0000-4000-8000-000000000005",
    reason: "operator reconciled conflict",
    confirm: "DISCARD",
  };
  const missing = createReconciliationHandlers(deps())["edge.conflict.discard"];
  assert.ok(missing);
  await assert.rejects(missing(handlerContext(parsed)), { name: "HandlerCommandError" });

  const existing = createReconciliationHandlers(deps(() => undefined, true))[
    "edge.conflict.discard"
  ];
  assert.ok(existing);
  const outcome = await existing(handlerContext(parsed));
  assert.deepEqual(outcome.result, { queue_id: parsed.queue_id, discarded: true });
  assert.equal(outcome.audit?.entity, "edge_replay_conflict");
});

class ReconciliationSqlClient implements SqlClient {
  readonly params: unknown[][] = [];

  async query<TRow = unknown>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<TRow>> {
    this.params.push([...params]);
    let rows: readonly unknown[] = [];
    if (sql.includes("FROM orders")) {
      rows = [{ order_count: 1, payable_cents: "1000", paid_cents: "700", balance_cents: "300" }];
    } else if (sql.includes("WITH signed")) {
      rows = [
        {
          method: "cash",
          kind: "pay",
          row_count: 1,
          amount_cents: "700",
          net_cents: "700",
          gross_cents: "700",
          refund_cents: "0",
        },
        {
          method: "cash",
          kind: "refund",
          row_count: 1,
          amount_cents: "300",
          net_cents: "-300",
          gross_cents: "0",
          refund_cents: "300",
        },
        {
          method: "balance",
          kind: "pay",
          row_count: 1,
          amount_cents: "300",
          net_cents: "300",
          gross_cents: "300",
          refund_cents: "0",
        },
      ];
    } else if (sql.includes("FROM print_jobs")) {
      rows = [
        { value: "done", count: 2 },
        { value: "uncertain", count: 1 },
      ];
    } else if (sql.includes("FROM edge_replay_records")) {
      rows = [{ value: "collision", count: 1 }];
    }
    return Object.freeze({
      rows: Object.freeze(rows) as readonly TRow[],
      rowCount: rows.length,
    });
  }
}

test("PostgreSQL reconciliation source uses store-day UTC bounds and safe signed aggregates", async () => {
  const client = new ReconciliationSqlClient();
  const result = await createPgReconciliationSource("Asia/Taipei", 6).readDay({
    client,
    tenant: TENANT,
    businessDate: "2026-07-30",
  });
  assert.equal(result.ledger.gross_cents, 1000);
  assert.equal(result.ledger.refund_cents, 300);
  assert.equal(result.ledger.net_cents, 700);
  assert.equal(result.ledger.difference_from_orders_cents, 0);
  assert.deepEqual(result.ledger.buckets, [
    { method: "cash", kind: "pay", row_count: 1, amount_cents: 700, net_cents: 700 },
    { method: "cash", kind: "refund", row_count: 1, amount_cents: 300, net_cents: -300 },
    {
      method: "balance",
      kind: "pay",
      row_count: 1,
      amount_cents: 300,
      net_cents: 300,
    },
  ]);
  assert.deepEqual(result.print.statuses, [
    { status: "done", count: 2 },
    { status: "uncertain", count: 1 },
  ]);
  assert.equal(result.edge_replay.conflict_count, 1);
  const boundedCall = client.params.find(
    (params) => params[2] instanceof Date && params[3] instanceof Date,
  );
  assert.ok(boundedCall);
  assert.equal((boundedCall[2] as Date).toISOString(), "2026-07-29T22:00:00.000Z");
  assert.equal((boundedCall[3] as Date).toISOString(), "2026-07-30T22:00:00.000Z");

  const csv = buildReconciliationCsv({
    ...result,
    generated_at: NOW.toISOString(),
  });
  assert.doesNotMatch(csv, /customer|phone|note|error|payload/iu);
});
