import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { readPgOwnerDrilldown } from "./pg-drilldown-source.js";
import {
  listPgOwnerPortfolioStores,
  withPgAuthorizedPortfolioStore,
} from "./pg-portfolio-source.js";
import type { OwnerDashboardDrilldownReadRequest } from "./types.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const TARGET_STORE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type QueryCall = Readonly<{ sql: string; params?: readonly unknown[] }>;

class ScriptedClient implements SqlClient {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly respond: (
      sql: string,
      params: readonly unknown[] | undefined,
    ) => readonly unknown[],
  ) {}

  async query<TRow = unknown>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<TRow>> {
    this.calls.push(Object.freeze({ sql, ...(params === undefined ? {} : { params }) }));
    const rows = this.respond(sql, params) as readonly TRow[];
    return Object.freeze({ rows, rowCount: rows.length });
  }
}

function request(
  client: SqlClient,
  kind: OwnerDashboardDrilldownReadRequest["kind"],
): OwnerDashboardDrilldownReadRequest {
  return Object.freeze({
    client,
    tenant: TENANT,
    kind,
    businessDate: "2026-08-07",
    dayStartedAt: new Date("2026-08-06T19:00:00.000Z"),
    nextDayStartedAt: new Date("2026-08-07T19:00:00.000Z"),
    overdueCutoff: new Date("2026-07-08T18:30:00.000Z"),
    limit: 50,
  });
}

test("PostgreSQL owner drilldowns keep full totals, fixed bounds and explicit tenant predicates", async () => {
  const cases = [
    {
      kind: "today_pickups" as const,
      params: [
        TENANT.orgId,
        TENANT.storeId,
        "2026-08-06T19:00:00.000Z",
        "2026-08-07T19:00:00.000Z",
        50,
      ],
      row: {
        total_row_count: "1",
        total_measure: "2",
        ticket_no: "T-PICK",
        occurred_at: "2026-08-07T17:00:00.000Z",
        garment_count: "2",
        balance_cents: null,
      },
    },
    {
      kind: "new_receivables" as const,
      params: [TENANT.orgId, TENANT.storeId, "2026-08-07", 50],
      row: {
        total_row_count: "1",
        total_measure: "4500",
        ticket_no: "T-DEBT",
        occurred_at: "2026-08-07T16:00:00.000Z",
        garment_count: null,
        balance_cents: "4500",
      },
    },
    {
      kind: "stagnant_garments" as const,
      params: [TENANT.orgId, TENANT.storeId, "2026-07-08T18:30:00.000Z", 50],
      row: {
        total_row_count: "1",
        total_measure: "3",
        ticket_no: "T-OLD",
        occurred_at: "2026-07-01T16:00:00.000Z",
        garment_count: "3",
        balance_cents: "500",
      },
    },
  ];

  for (const value of cases) {
    const client = new ScriptedClient(() => Object.freeze([value.row]));
    const result = await readPgOwnerDrilldown(request(client, value.kind));
    assert.equal(result.kind, value.kind);
    assert.equal(result.totalRowCount, 1);
    assert.equal(result.rows.length, 1);
    const query = client.calls[0];
    assert.ok(query);
    assert.match(query.sql, /org_id = \$1::uuid/u);
    assert.match(query.sql, /store_id = \$2::uuid/u);
    assert.doesNotMatch(query.sql, new RegExp(TENANT.orgId, "u"));
    assert.deepEqual(query.params, value.params);
  }
});

test("PostgreSQL owner drilldown represents an empty result with full zero totals", async () => {
  const client = new ScriptedClient(() =>
    Object.freeze([
      Object.freeze({
        total_row_count: "0",
        total_measure: "0",
        ticket_no: null,
        occurred_at: null,
        garment_count: null,
        balance_cents: null,
      }),
    ]),
  );
  const result = await readPgOwnerDrilldown(request(client, "stagnant_garments"));
  assert.deepEqual(result, {
    kind: "stagnant_garments",
    totalRowCount: 0,
    overdueGarmentCount: 0,
    overdueOrderCount: 0,
    rows: [],
  });
});

test("PostgreSQL portfolio enumerates only the server tenant organization in stable order", async () => {
  const client = new ScriptedClient(() =>
    Object.freeze([
      Object.freeze({ id: TENANT.storeId, code: "a", name: "A 店", timezone: "Asia/Shanghai" }),
      Object.freeze({ id: TARGET_STORE_ID, code: "b", name: "B 店", timezone: "UTC" }),
    ]),
  );
  const stores = await listPgOwnerPortfolioStores(client, TENANT);
  assert.deepEqual(stores, [
    { storeId: TENANT.storeId, storeCode: "a", storeName: "A 店", timeZone: "Asia/Shanghai" },
    { storeId: TARGET_STORE_ID, storeCode: "b", storeName: "B 店", timeZone: "UTC" },
  ]);
  assert.match(client.calls[0]?.sql ?? "", /WHERE store\.org_id = \$1::uuid/u);
  assert.match(client.calls[0]?.sql ?? "", /ORDER BY store\.code ASC, store\.id ASC/u);
  assert.match(client.calls[0]?.sql ?? "", /LIMIT \$2::integer/u);
  assert.deepEqual(client.calls[0]?.params, [TENANT.orgId, 201]);
});

test("PostgreSQL portfolio fails closed before an unbounded candidate scan", async () => {
  const rows = Object.freeze(
    Array.from({ length: 201 }, (_, index) =>
      Object.freeze({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        code: `store-${String(index).padStart(3, "0")}`,
        name: `Store ${index}`,
        timezone: "Asia/Shanghai",
      }),
    ),
  );
  const client = new ScriptedClient(() => rows);
  await assert.rejects(
    () => listPgOwnerPortfolioStores(client, TENANT),
    /owner portfolio candidate limit exceeded/u,
  );
  assert.deepEqual(client.calls[0]?.params, [TENANT.orgId, 201]);
});

test("PostgreSQL portfolio switches RLS scope, proves active admin and always restores store GUC", async () => {
  const client = new ScriptedClient((sql) => {
    if (sql.includes("SELECT EXISTS")) return Object.freeze([Object.freeze({ authorized: true })]);
    return Object.freeze([]);
  });
  const store = Object.freeze({
    storeId: TARGET_STORE_ID,
    storeCode: "target",
    storeName: "目标店",
    timeZone: "UTC",
  });
  const result = await withPgAuthorizedPortfolioStore(
    Object.freeze({ client, tenant: TENANT, store }),
    async (tenant) => {
      assert.deepEqual(tenant, { ...TENANT, storeId: TARGET_STORE_ID });
      return "visible";
    },
  );
  assert.equal(result, "visible");
  assert.deepEqual(
    client.calls.map((call) => call.params),
    [[TARGET_STORE_ID], [TENANT.orgId, TARGET_STORE_ID, TENANT.staffId], [TENANT.storeId]],
  );
  const authorizationSql = client.calls[1]?.sql ?? "";
  assert.match(authorizationSql, /store_role\.org_id = \$1::uuid/u);
  assert.match(authorizationSql, /store_role\.store_id = \$2::uuid/u);
  assert.match(authorizationSql, /store_role\.staff_id = \$3::uuid/u);
  assert.match(authorizationSql, /store_role\.role = 'admin'/u);
  assert.match(authorizationSql, /store_role\.is_active/u);
  assert.match(authorizationSql, /staff\.is_active/u);
});

test("PostgreSQL portfolio hides unauthorized stores and restores after callback failure", async () => {
  let authorized = false;
  const client = new ScriptedClient((sql) =>
    sql.includes("SELECT EXISTS")
      ? Object.freeze([Object.freeze({ authorized })])
      : Object.freeze([]),
  );
  const store = Object.freeze({
    storeId: TARGET_STORE_ID,
    storeCode: "target",
    storeName: "目标店",
    timeZone: "UTC",
  });
  let called = false;
  const hidden = await withPgAuthorizedPortfolioStore(
    Object.freeze({ client, tenant: TENANT, store }),
    async () => {
      called = true;
      return "unexpected";
    },
  );
  assert.equal(hidden, null);
  assert.equal(called, false);
  assert.deepEqual(client.calls.at(-1)?.params, [TENANT.storeId]);

  authorized = true;
  const sentinel = new Error("portfolio-read-failed");
  await assert.rejects(
    () =>
      withPgAuthorizedPortfolioStore(Object.freeze({ client, tenant: TENANT, store }), async () =>
        Promise.reject(sentinel),
      ),
    (error: unknown) => error === sentinel,
  );
  assert.deepEqual(client.calls.at(-1)?.params, [TENANT.storeId]);
});
