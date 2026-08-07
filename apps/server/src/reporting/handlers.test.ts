import assert from "node:assert/strict";
import test from "node:test";

import { aggregateAccountingReport } from "@laundry/domain";

import type { AccountingReadRequest } from "../accounting/types.js";
import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createReportingHandlers } from "./handlers.js";
import { createMemoryOwnerDashboardSource } from "./memory-source.js";
import type { OwnerDashboardReadRequest, ReportingHandlerDeps } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});
const NOW = new Date("2026-08-07T18:30:00.000Z");

function actor(permissions: readonly string[]): ActorContext {
  return Object.freeze({
    staffId: STAFF_ID,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze([...permissions]),
  });
}

function deps(recorded: OwnerDashboardReadRequest[]): ReportingHandlerDeps {
  return Object.freeze({
    accounting: Object.freeze({
      readReport: async (request: AccountingReadRequest) => {
        assert.equal(request.dateFrom, "2026-07-09");
        assert.equal(request.dateTo, "2026-08-07");
        assert.equal(request.groupBy, "day");
        assert.equal(request.staffId, null);
        return aggregateAccountingReport([], "day");
      },
    }),
    source: Object.freeze({
      ...createMemoryOwnerDashboardSource(),
      readOperations: async (request: OwnerDashboardReadRequest) => {
        recorded.push(request);
        return Object.freeze({
          pickedUpGarmentCount: 3,
          newReceivableCents: 2_500,
          newReceivableOrderCount: 1,
          overdueGarmentCount: 5,
          overdueOrderCount: 2,
        });
      },
    }),
    timeZone: "Asia/Shanghai",
    rolloverHour: 3,
    now: () => NOW,
  });
}

async function run(handler: CommandHandler, parsed: Readonly<Record<string, unknown>>) {
  const client = new FakeSqlClient();
  const outcome = await handler(
    Object.freeze({
      client,
      tenant: TENANT,
      actor: actor(["accounting_read"]),
      parsed,
    }) as unknown as Parameters<CommandHandler>[0],
  );
  return Object.freeze({ client, outcome });
}

test("owner dashboard derives all scope and dates from the authenticated server context", async () => {
  const recorded: OwnerDashboardReadRequest[] = [];
  const { client, outcome } = await run(
    createReportingHandlers(deps(recorded))["reporting.owner_dashboard.get"],
    {},
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.client, client);
  assert.deepEqual(recorded[0]?.tenant, TENANT);
  assert.equal(recorded[0]?.businessDate, "2026-08-07");
  assert.equal(recorded[0]?.dayStartedAt.toISOString(), "2026-08-06T19:00:00.000Z");
  assert.equal(recorded[0]?.nextDayStartedAt.toISOString(), "2026-08-07T19:00:00.000Z");
  assert.equal(recorded[0]?.overdueCutoff.toISOString(), "2026-07-08T18:30:00.000Z");

  const result = outcome.result as Readonly<{
    business_date: string;
    trend: readonly unknown[];
    today: Readonly<{ picked_up_garment_count: number; overdue_garment_count: number }>;
  }>;
  assert.equal(result.business_date, "2026-08-07");
  assert.equal(result.trend.length, 30);
  assert.equal(result.today.picked_up_garment_count, 3);
  assert.equal(result.today.overdue_garment_count, 5);
});

test("owner dashboard direct calls fail closed on permission and strict input", async () => {
  const handler = createReportingHandlers(deps([]))["reporting.owner_dashboard.get"];
  const deniedContext = Object.freeze({
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor: actor([]),
    parsed: {},
  }) as unknown as Parameters<CommandHandler>[0];
  await assert.rejects(
    () => handler(deniedContext),
    (error: unknown) => {
      assert.ok(error instanceof HandlerCommandError);
      assert.equal(error.commandError.code, "PERMISSION_DENIED");
      return true;
    },
  );
  await assert.rejects(() => run(handler, { business_date: "2026-08-07" }), /unrecognized/i);
});
