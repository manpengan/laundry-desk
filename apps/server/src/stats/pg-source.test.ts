import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgStatsQuery } from "./pg-source.js";

test("PG stats source uses one aggregate per read under store RLS scope", async () => {
  const queries: string[] = [];
  const client = {
    async query<TRow>(sql: string): Promise<{ rows: TRow[]; rowCount: number }> {
      queries.push(sql);
      if (sql.includes("WITH orders_day AS")) {
        return {
          rows: [
            {
              order_count: "2",
              garment_count: "3",
              payable_cents: "5000",
              paid_cents: "3000",
              balance_cents: "2000",
              payment_cents: "1000",
              picked_garment_count: "1",
            } as TRow,
          ],
          rowCount: 1,
        };
      }
      if (sql.includes("AS cash_cents")) {
        return { rows: [{ cash_cents: "0" } as TRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release(): void {
      // Capturing test double.
    },
  } as unknown as PgPoolClient;
  const pool = { connect: async () => client } as unknown as PgPool;

  const source = createPgStatsQuery(pool);
  const summary = await source.daySummary({
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    businessDate: "2026-07-23",
  });

  assert.deepEqual(summary, {
    business_date: "2026-07-23",
    order_count: 2,
    garment_count: 3,
    payable_cents: 5000,
    paid_cents: 3000,
    balance_cents: 2000,
    payment_cents: 1000,
    picked_garment_count: 1,
  });
  const aggregate = queries.find((sql) => sql.includes("WITH orders_day AS"));
  assert.ok(aggregate);
  assert.match(aggregate, /FROM payments p/u);
  assert.match(aggregate, /g\.status = 'picked_up'/u);
  assert.match(aggregate, /o\.status IN \('open', 'closed'\)/u);
  assert.deepEqual(
    await source.cashSummary({
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
      businessDate: "2026-07-23",
    }),
    { cash_cents: 0 },
  );
  const cash = queries.find((sql) => sql.includes("AS cash_cents"));
  assert.ok(cash);
  assert.match(cash, /LEFT JOIN payments referenced/u);
  assert.match(cash, /referenced\.kind = 'refund'/u);
  assert.equal(queries.filter((sql) => sql === "BEGIN").length, 2);
});
