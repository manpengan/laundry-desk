/**
 * Real-PostgreSQL acceptance for the shift closing read paths.
 *
 * The sibling pg-shift-store.test.ts runs against a capturing pool, so its only
 * evidence for `getMostRecentBefore` was a regex over the SQL text
 * (`/ORDER BY business_date DESC, closed_at DESC, id DESC/`). A regex proves the
 * string was assembled, never that PostgreSQL orders or filters that way — the
 * same blind spot that let migration 0019 ship a business_date CHECK which
 * rejected every date. The ordering and the strict `<` boundary are what the
 * shift handler depends on to name the previous shift, so they run against a
 * real database here.
 *
 * Dates live in 2098 so the fixed windows can never collide with the workday
 * acceptance, which deletes its own business dates on the shared database.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgShiftStore } from "./pg-shift-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

/** Fixed, ordered window. `MIDDLE` is the answer for anything after it. */
const EARLIEST = "2098-03-01";
const MIDDLE = "2098-03-02";
const LATEST = "2098-03-05";
const ALL_DATES = Object.freeze([EARLIEST, MIDDLE, LATEST]);

const CLOSED_AT_BASE = 4_048_000_000;

function snapshotFor(index: number) {
  return Object.freeze({
    order_count: index + 1,
    payable_cents: 1_000 * (index + 1),
    paid_cents: 500 * (index + 1),
    payment_cents: 0,
  });
}

/**
 * shift_closings is append-only for laundry_app (SELECT + INSERT, no DELETE), so
 * the fixture window is reclaimed as laundry_owner on the admin pool — the same
 * escape hatch the workday acceptance uses. The app role never gains a delete
 * path just to make a test convenient.
 */
async function purgeWindow(adminPool: ReturnType<typeof createPgPool>): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE laundry_owner");
    await client.query(
      `DELETE FROM shift_closings
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = ANY($3::text[])`,
      [DEMO_ORG_ID, DEMO_STORE_ID, [...ALL_DATES]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

maybe("PG shift reads order by business date and honour a strict earlier-than bound", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });

  try {
    await seedPgTestIdentityFixture(adminPool);
    const store = createPgShiftStore(appPool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });
    await purgeWindow(adminPool);

    // Insert out of chronological order so a store that returns insertion order
    // instead of business_date order cannot pass by accident.
    for (const [index, businessDate] of [MIDDLE, LATEST, EARLIEST].entries()) {
      await store.close({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        business_date: businessDate,
        closed_by_staff_id: DEMO_STAFF_A_ID,
        signature_name: `店员${index}`,
        snapshot: snapshotFor(index),
        closed_at: CLOSED_AT_BASE + index,
      });
    }

    // Exact match is the day itself, never a neighbour.
    const exact = await store.getByBusinessDate(DEMO_ORG_ID, DEMO_STORE_ID, MIDDLE);
    assert.equal(exact?.business_date, MIDDLE);

    // The bound is strict: asking from MIDDLE must skip MIDDLE itself.
    const beforeMiddle = await store.getMostRecentBefore(DEMO_ORG_ID, DEMO_STORE_ID, MIDDLE);
    assert.equal(
      beforeMiddle?.business_date,
      EARLIEST,
      "getMostRecentBefore must exclude the requested date itself",
    );

    // From a date past every row, the newest one wins — this is the ordering the
    // SQL-text regex could only assume.
    const beforeFuture = await store.getMostRecentBefore(DEMO_ORG_ID, DEMO_STORE_ID, "2098-03-31");
    assert.equal(
      beforeFuture?.business_date,
      LATEST,
      "the most recent earlier closing must win, not the earliest or the last inserted",
    );

    // A date at or before the first row has no predecessor at all.
    assert.equal(await store.getMostRecentBefore(DEMO_ORG_ID, DEMO_STORE_ID, EARLIEST), null);

    // Snapshot columns survive the round trip on the row that ordering picked.
    assert.equal(beforeFuture?.order_count, 2);
    assert.equal(beforeFuture?.payable_cents, 2_000);
    assert.equal(beforeFuture?.signature_name, "店员1");
  } finally {
    await purgeWindow(adminPool).catch(() => undefined);
    await appPool.end();
    await adminPool.end();
  }
});

maybe("PG shift history is bounded by range, newest first, and store scoped", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });

  try {
    await seedPgTestIdentityFixture(adminPool);
    const store = createPgShiftStore(appPool, { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });
    await purgeWindow(adminPool);

    for (const [index, businessDate] of ALL_DATES.entries()) {
      await store.close({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        business_date: businessDate,
        closed_by_staff_id: DEMO_STAFF_A_ID,
        signature_name: `店员${index}`,
        snapshot: snapshotFor(index),
        closed_at: CLOSED_AT_BASE + index,
      });
    }

    const full = await store.listHistory(DEMO_ORG_ID, DEMO_STORE_ID, EARLIEST, LATEST, 10);
    assert.deepEqual(
      full.map((row) => row.business_date),
      [LATEST, MIDDLE, EARLIEST],
      "history must come back newest first",
    );

    // Both ends of the range are inclusive.
    const inner = await store.listHistory(DEMO_ORG_ID, DEMO_STORE_ID, MIDDLE, MIDDLE, 10);
    assert.deepEqual(
      inner.map((row) => row.business_date),
      [MIDDLE],
    );

    // The limit keeps the newest rows, not an arbitrary slice.
    const capped = await store.listHistory(DEMO_ORG_ID, DEMO_STORE_ID, EARLIEST, LATEST, 2);
    assert.deepEqual(
      capped.map((row) => row.business_date),
      [LATEST, MIDDLE],
    );
  } finally {
    await purgeWindow(adminPool).catch(() => undefined);
    await appPool.end();
    await adminPool.end();
  }
});
