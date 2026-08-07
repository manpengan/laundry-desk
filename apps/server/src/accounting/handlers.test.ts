import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { AccountingMovement } from "@laundry/domain";
import type { AccountingReportResult } from "@laundry/contracts";

import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { buildAccountingCsv, escapeAccountingCsvCell } from "./csv.js";
import { createAccountingHandlers } from "./handlers.js";
import { createMemoryAccountingSource } from "./memory-source.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});
const NOW = new Date("2026-08-07T05:00:00.000Z");

const MOVEMENTS: readonly AccountingMovement[] = Object.freeze([
  Object.freeze({
    source: "order",
    business_date: "2026-08-07",
    staff_id: STAFF_ID,
    staff_name: "=店员",
    method: "cash",
    net_cents: 5_000,
    ledger_row_count: 1,
  }),
  Object.freeze({
    source: "stored_value",
    business_date: "2026-08-07",
    staff_id: STAFF_ID,
    staff_name: "=店员",
    method: "cash",
    net_cents: 10_000,
    ledger_row_count: 1,
  }),
  Object.freeze({
    source: "order",
    business_date: "2026-08-07",
    staff_id: STAFF_ID,
    staff_name: "=店员",
    method: "balance",
    net_cents: 3_000,
    ledger_row_count: 1,
  }),
]);

function actor(permissions: readonly string[]): ActorContext {
  return Object.freeze({
    staffId: STAFF_ID,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze([...permissions]),
  });
}

async function run(
  handler: CommandHandler,
  parsed: Readonly<Record<string, unknown>>,
  permissions: readonly string[],
) {
  return handler(
    Object.freeze({
      client: new FakeSqlClient(),
      tenant: TENANT,
      actor: actor(permissions),
      parsed,
    }) as unknown as Parameters<CommandHandler>[0],
  );
}

function handlers() {
  return createAccountingHandlers({
    source: createMemoryAccountingSource(MOVEMENTS),
    timeZone: "UTC",
    now: () => NOW,
  });
}

test("accounting report derives the current server business day and both bases", async () => {
  const outcome = await run(handlers()["accounting.report.get"], {}, ["accounting_read"]);
  const result = outcome.result as Readonly<{
    date_from: string;
    date_to: string;
    totals: Readonly<{ real_income_cents: number; performance_income_cents: number }>;
  }>;
  assert.equal(result.date_from, "2026-08-07");
  assert.equal(result.date_to, "2026-08-07");
  assert.deepEqual(result.totals, {
    real_income_cents: 15_000,
    performance_income_cents: 8_000,
    order_cashflow_cents: 5_000,
    stored_value_cashflow_cents: 10_000,
    stored_value_consumption_cents: 3_000,
    ledger_row_count: 3,
  });
});

test("accounting handlers fail closed on direct calls without both permissions", async () => {
  const denied = (code: string) => (error: unknown) => {
    assert.ok(error instanceof HandlerCommandError);
    assert.equal(error.commandError.code, code);
    return true;
  };
  await assert.rejects(
    () => run(handlers()["accounting.report.get"], {}, []),
    denied("PERMISSION_DENIED"),
  );
  await assert.rejects(
    () => run(handlers()["accounting.report.export"], { format: "csv" }, ["accounting_read"]),
    denied("PERMISSION_DENIED"),
  );
});

test("accounting export is deterministic, hardened and audited without raw CSV", async () => {
  const queried = await run(handlers()["accounting.report.get"], { group_by: "staff" }, [
    "accounting_read",
  ]);
  const expectedCsv = buildAccountingCsv(queried.result as AccountingReportResult);
  const outcome = await run(
    handlers()["accounting.report.export"],
    { format: "csv", group_by: "staff" },
    ["accounting_read", "ledger_export"],
  );
  const result = outcome.result as Readonly<{
    filename: string;
    content_sha256: string;
    csv: string;
  }>;
  assert.equal(result.filename, "accounting-2026-08-07-2026-08-07-staff.csv");
  assert.equal(
    result.content_sha256,
    createHash("sha256").update(result.csv, "utf8").digest("hex"),
  );
  assert.match(result.csv, /'=店员/u);
  assert.equal(result.csv, expectedCsv);
  assert.doesNotMatch(JSON.stringify(outcome.audit), /'=店员|real_income/u);
  assert.equal(escapeAccountingCsvCell(" +1"), '"\' +1"');
});
