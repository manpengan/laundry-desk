/**
 * Real-PostgreSQL acceptance for the counter customer search.
 *
 * The sibling pg-customer-store.test.ts drives a capturing pool, so its evidence
 * was the SQL text (`includes("ORDER BY updated_at DESC")`, `includes("ILIKE")`)
 * plus the two pattern parameters. That shows the query was assembled; it cannot
 * show what PostgreSQL returns. Three properties the counter actually depends on
 * were therefore untested:
 *
 *   1. results really come back most-recently-updated first;
 *   2. ILIKE really is case-insensitive and the prefix/contains split really
 *      matches phones and names the way the counter expects;
 *   3. merged and anonymized customers are really excluded — a privacy
 *      obligation, not a cosmetic filter.
 *
 * (3) is the reason this file exists: a capturing pool would happily "pass"
 * while the WHERE clause leaked anonymized rows into the counter's lookup.
 *
 * The integration database is shared, so every case tags its rows with a unique
 * marker and asserts only over its own.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgCustomerStore } from "./pg-customer-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

/** Six digits keep every generated phone inside one org-unique 11-digit space. */
function phoneFor(marker: string, tail: string): string {
  return `19${marker}${tail}`;
}

maybe("PG customer search orders by recency and matches phone prefix and name", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });

  try {
    const store = createPgCustomerStore(pool, { orgId: DEMO_ORG_ID });
    const marker = String(Math.floor(Math.random() * 900_000) + 100_000);
    const base = 1_950_000_000;

    // Insert oldest-updated first; the expected order is the reverse.
    const older = await store.upsert({
      phone: phoneFor(marker, "001"),
      name: `Zhang${marker}`,
      now: base,
    });
    const newer = await store.upsert({
      phone: phoneFor(marker, "002"),
      name: `wang${marker}`,
      now: base + 600,
    });

    const mine = (rows: readonly { phone: string }[]) =>
      rows.filter((row) => row.phone.includes(marker)).map((row) => row.phone);

    // Phone prefix: "19<marker>" is a prefix of both rows.
    const byPrefix = await store.search(`19${marker}`, 50);
    assert.deepEqual(
      mine(byPrefix),
      [phoneFor(marker, "002"), phoneFor(marker, "001")],
      "search must return most-recently-updated first",
    );

    // Name match is case-insensitive, which is exactly what ILIKE buys and what
    // a SQL-text assertion could not demonstrate.
    const byUpperName = await store.search(`ZHANG${marker}`, 50);
    assert.deepEqual(mine(byUpperName), [phoneFor(marker, "001")]);
    const byLowerName = await store.search(`WANG${marker}`, 50);
    assert.deepEqual(mine(byLowerName), [phoneFor(marker, "002")]);

    // A mid-string phone fragment matches through the contains pattern.
    const byFragment = await store.search(marker, 50);
    assert.equal(mine(byFragment).length, 2);

    assert.equal(older.created, true);
    assert.equal(newer.created, true);
  } finally {
    await pool.end();
  }
});

maybe("PG customer search hides merged and anonymized customers", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });

  try {
    const store = createPgCustomerStore(pool, { orgId: DEMO_ORG_ID });
    const marker = String(Math.floor(Math.random() * 900_000) + 100_000);
    const now = 1_960_000_000;

    const survivor = await store.upsert({ phone: phoneFor(marker, "010"), now });
    const merged = await store.upsert({ phone: phoneFor(marker, "011"), now });
    const anonymized = await store.upsert({ phone: phoneFor(marker, "012"), now });

    const visible = await store.search(marker, 50);
    assert.equal(
      visible.filter((row) => row.phone.includes(marker)).length,
      3,
      "all three must be visible before they are retired",
    );

    // Retire two of them the way the privacy commands do.
    await withPoolClient(pool, (sql) =>
      withTenantTransaction(sql, TENANT, async (tx) => {
        // Canonical merge columns are owner-only; exercise the granted definer
        // primitive instead of bypassing its advisory-lock ordering.
        await tx.query("SELECT * FROM customer_merge_canonical($1::uuid, $2::uuid, now())", [
          merged.customer.customer_id,
          survivor.customer.customer_id,
        ]);
        // customers_anonymized_pair_chk likewise refuses an anonymization that
        // does not record who performed it.
        await tx.query(
          `UPDATE customers
              SET anonymized_at = now(), anonymized_by_staff_id = $2::uuid
            WHERE id = $1::uuid`,
          [anonymized.customer.customer_id, DEMO_STAFF_A_ID],
        );
      }),
    );

    const afterRetirement = await store.search(marker, 50);
    assert.deepEqual(
      afterRetirement.filter((row) => row.phone.includes(marker)).map((row) => row.phone),
      [phoneFor(marker, "010")],
      "a merged or anonymized customer must never surface in counter search",
    );

    // The same exclusion must hold on the empty-query listing path, which is a
    // different SQL statement in the store.
    const listing = await store.search(undefined, 50);
    assert.equal(
      listing.some(
        (row) => row.phone === phoneFor(marker, "011") || row.phone === phoneFor(marker, "012"),
      ),
      false,
      "the empty-query listing must apply the same privacy filter",
    );
  } finally {
    await pool.end();
  }
});

maybe("PG customer search caps its page at fifty rows regardless of the request", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });

  try {
    const store = createPgCustomerStore(pool, { orgId: DEMO_ORG_ID });

    // The cap is Math.min(limit, 50); ask for far more and for zero.
    const capped = await store.search(undefined, 5_000);
    assert.ok(capped.length <= 50, `search returned ${capped.length} rows, over the hard cap`);

    assert.deepEqual(await store.search(undefined, 0), []);
    assert.deepEqual(await store.search("1", -3), []);
  } finally {
    await pool.end();
  }
});
