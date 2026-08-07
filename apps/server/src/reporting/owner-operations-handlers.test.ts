import assert from "node:assert/strict";
import test from "node:test";

import { aggregateAccountingReport } from "@laundry/domain";

import type { AccountingReadRequest } from "../accounting/types.js";
import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createReportingHandlers } from "./handlers.js";
import type {
  OwnerDashboardDrilldownReadRequest,
  OwnerDashboardReadRequest,
  OwnerPortfolioStoreCandidate,
  OwnerPortfolioStoreScopeRequest,
  ReportingHandlerDeps,
} from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_STORE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const HIDDEN_STORE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NOW = new Date("2026-08-07T18:30:00.000Z");
const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});

function actor(permissions: readonly string[] = ["accounting_read"]): ActorContext {
  return Object.freeze({ staffId: STAFF_ID, deviceId: null, via: "ui", permissions });
}

async function run(handler: CommandHandler, parsed: Readonly<Record<string, unknown>>) {
  const client = new FakeSqlClient();
  const outcome = await handler(
    Object.freeze({
      client,
      tenant: TENANT,
      actor: actor(),
      parsed,
    }) as unknown as Parameters<CommandHandler>[0],
  );
  return Object.freeze({ client, outcome });
}

function candidate(
  storeId: string,
  storeCode: string,
  timeZone: string,
): OwnerPortfolioStoreCandidate {
  return Object.freeze({ storeId, storeCode, storeName: `门店 ${storeCode}`, timeZone });
}

test("owner drilldown derives tenant, business day and fixed bounds on the server", async () => {
  const recorded: OwnerDashboardDrilldownReadRequest[] = [];
  const deps: ReportingHandlerDeps = Object.freeze({
    accounting: Object.freeze({ readReport: async () => aggregateAccountingReport([], "day") }),
    source: Object.freeze({
      readOperations: async () =>
        Object.freeze({
          pickedUpGarmentCount: 0,
          newReceivableCents: 0,
          newReceivableOrderCount: 0,
          overdueGarmentCount: 0,
          overdueOrderCount: 0,
        }),
      readDrilldown: async (request: OwnerDashboardDrilldownReadRequest) => {
        recorded.push(request);
        return Object.freeze({
          kind: "today_pickups" as const,
          totalRowCount: 1,
          pickedUpGarmentCount: 2,
          rows: Object.freeze([
            Object.freeze({
              ticketNo: "20260807-0001",
              pickedAt: new Date("2026-08-07T17:00:00.000Z"),
              garmentCount: 2,
            }),
          ]),
        });
      },
      listPortfolioStores: async () => Object.freeze([]),
      withAuthorizedPortfolioStore: async <TResult>(
        _request: OwnerPortfolioStoreScopeRequest,
        read: (tenant: TenantContext) => Promise<TResult>,
      ) => read(TENANT),
    }),
    timeZone: "Asia/Shanghai",
    rolloverHour: 3,
    now: () => NOW,
  });

  const { client, outcome } = await run(
    createReportingHandlers(deps)["reporting.owner_dashboard.drilldown"],
    { kind: "today_pickups" },
  );
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.client, client);
  assert.deepEqual(recorded[0]?.tenant, TENANT);
  assert.equal(recorded[0]?.businessDate, "2026-08-07");
  assert.equal(recorded[0]?.dayStartedAt.toISOString(), "2026-08-06T19:00:00.000Z");
  assert.equal(recorded[0]?.nextDayStartedAt.toISOString(), "2026-08-07T19:00:00.000Z");
  assert.equal(recorded[0]?.overdueCutoff.toISOString(), "2026-07-08T18:30:00.000Z");
  assert.equal(recorded[0]?.limit, 50);
  assert.equal(recorded[0]?.kind, "today_pickups");
  assert.deepEqual(outcome.result, {
    business_date: "2026-08-07",
    generated_at: "2026-08-07T18:30:00.000Z",
    kind: "today_pickups",
    total_row_count: 1,
    truncated: false,
    totals: { picked_up_garment_count: 2, picked_up_order_count: 1 },
    rows: [
      {
        ticket_no: "20260807-0001",
        picked_at: "2026-08-07T17:00:00.000Z",
        garment_count: 2,
      },
    ],
  });
});

test("owner drilldown fails closed on permission and client scope fields", async () => {
  const deps = Object.freeze({
    accounting: Object.freeze({ readReport: async () => aggregateAccountingReport([], "day") }),
    source: Object.freeze({
      readOperations: async () => Promise.reject(new Error("unexpected")),
      readDrilldown: async () => Promise.reject(new Error("unexpected")),
      listPortfolioStores: async () => Object.freeze([]),
      withAuthorizedPortfolioStore: async () => null,
    }),
    timeZone: "UTC",
    now: () => NOW,
  }) satisfies ReportingHandlerDeps;
  const handler = createReportingHandlers(deps)["reporting.owner_dashboard.drilldown"];
  const denied = Object.freeze({
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor: actor([]),
    parsed: { kind: "today_pickups" },
  }) as unknown as Parameters<CommandHandler>[0];
  await assert.rejects(
    () => handler(denied),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "PERMISSION_DENIED",
  );
  await assert.rejects(
    () => run(handler, { kind: "today_pickups", store_id: OTHER_STORE_ID }),
    /unrecognized/iu,
  );
  await assert.rejects(
    () => run(handler, { kind: "today_pickups", business_date: "2026-08-07" }),
    /unrecognized/iu,
  );
});

test("owner portfolio aggregates only stores where the actor is an active admin", async () => {
  const stores = Object.freeze([
    candidate(STORE_ID, "a", "Asia/Shanghai"),
    candidate(OTHER_STORE_ID, "b", "Pacific/Kiritimati"),
    candidate(HIDDEN_STORE_ID, "c", "UTC"),
  ]);
  const accountingRequests: AccountingReadRequest[] = [];
  const operationRequests: OwnerDashboardReadRequest[] = [];
  const scopedStores: string[] = [];
  const deps: ReportingHandlerDeps = Object.freeze({
    accounting: Object.freeze({
      readReport: async (request: AccountingReadRequest) => {
        accountingRequests.push(request);
        return aggregateAccountingReport([], "day");
      },
    }),
    source: Object.freeze({
      readOperations: async (request: OwnerDashboardReadRequest) => {
        operationRequests.push(request);
        const other = request.tenant.storeId === OTHER_STORE_ID;
        return Object.freeze({
          pickedUpGarmentCount: other ? 2 : 1,
          newReceivableCents: other ? 2_000 : 1_000,
          newReceivableOrderCount: 1,
          overdueGarmentCount: other ? 4 : 3,
          overdueOrderCount: 1,
        });
      },
      readDrilldown: async () => Promise.reject(new Error("unexpected")),
      listPortfolioStores: async () => stores,
      withAuthorizedPortfolioStore: async <TResult>(
        request: OwnerPortfolioStoreScopeRequest,
        read: (tenant: TenantContext) => Promise<TResult>,
      ) => {
        scopedStores.push(request.store.storeId);
        if (request.store.storeId === HIDDEN_STORE_ID) return null;
        return read(Object.freeze({ ...request.tenant, storeId: request.store.storeId }));
      },
    }),
    timeZone: "Asia/Shanghai",
    rolloverHour: 3,
    now: () => NOW,
  });

  const { outcome } = await run(createReportingHandlers(deps)["reporting.owner_portfolio.get"], {});
  assert.deepEqual(scopedStores, [STORE_ID, OTHER_STORE_ID, HIDDEN_STORE_ID]);
  assert.deepEqual(
    accountingRequests.map((request) => [request.tenant.storeId, request.dateFrom, request.dateTo]),
    [
      [STORE_ID, "2026-08-07", "2026-08-07"],
      [OTHER_STORE_ID, "2026-08-08", "2026-08-08"],
    ],
  );
  assert.deepEqual(
    operationRequests.map((request) => [request.tenant.storeId, request.businessDate]),
    [
      [STORE_ID, "2026-08-07"],
      [OTHER_STORE_ID, "2026-08-08"],
    ],
  );
  assert.deepEqual(outcome.result, {
    generated_at: "2026-08-07T18:30:00.000Z",
    returned_store_count: 2,
    truncated: false,
    totals: {
      performance_income_cents: 0,
      real_income_cents: 0,
      picked_up_garment_count: 3,
      new_receivable_cents: 3_000,
      new_receivable_order_count: 2,
      overdue_garment_count: 7,
      overdue_order_count: 2,
    },
    stores: [
      {
        store_code: "a",
        store_name: "门店 a",
        timezone: "Asia/Shanghai",
        business_date: "2026-08-07",
        performance_income_cents: 0,
        real_income_cents: 0,
        picked_up_garment_count: 1,
        new_receivable_cents: 1_000,
        new_receivable_order_count: 1,
        overdue_garment_count: 3,
        overdue_order_count: 1,
      },
      {
        store_code: "b",
        store_name: "门店 b",
        timezone: "Pacific/Kiritimati",
        business_date: "2026-08-08",
        performance_income_cents: 0,
        real_income_cents: 0,
        picked_up_garment_count: 2,
        new_receivable_cents: 2_000,
        new_receivable_order_count: 1,
        overdue_garment_count: 4,
        overdue_order_count: 1,
      },
    ],
  });
});
