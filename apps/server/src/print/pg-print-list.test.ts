/**
 * Real-PostgreSQL acceptance for the print queue read path.
 *
 * The sibling pg-print-store.test.ts asserts ordering against a capturing pool,
 * and does it circularly: its mock only returns rows when the SQL happens to
 * contain "ORDER BY created_at DESC", then asserts the rows came back in that
 * order. That proves the string was assembled, not that PostgreSQL sorts by it.
 * The queue panel is what the counter watches to decide whether a ticket
 * printed, so the ordering and the limit run against a real database here.
 *
 * The integration database is shared and print_jobs is append-only in practice,
 * so every case filters to its own ticket prefix instead of assuming an empty
 * queue.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgPrintJobStore } from "./pg-print-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT = Object.freeze({ orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });

maybe("PG print list returns newest first and the limit keeps the newest", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });

  try {
    const store = createPgPrintJobStore(pool, TENANT);
    const marker = randomUUID().slice(0, 8);
    const base = 1_900_000_000;

    // Enqueue oldest first so insertion order and the expected result differ.
    const oldest = await store.enqueue({
      order_id: randomUUID(),
      ticket_no: `${marker}-old`,
      kind: "xp58",
      now: base,
    });
    const middle = await store.enqueue({
      order_id: randomUUID(),
      ticket_no: `${marker}-mid`,
      kind: "xp58",
      now: base + 60,
    });
    const newest = await store.enqueue({
      order_id: randomUUID(),
      ticket_no: `${marker}-new`,
      kind: "xp58",
      now: base + 120,
    });

    const mine = (rows: readonly { ticket_no: string }[]) =>
      rows.filter((row) => row.ticket_no.startsWith(marker)).map((row) => row.ticket_no);

    const listed = await store.list(200);
    assert.deepEqual(
      mine(listed),
      [`${marker}-new`, `${marker}-mid`, `${marker}-old`],
      "the queue must come back newest first",
    );

    // Identity and the mapped fields survive the round trip.
    const newestRow = listed.find((row) => row.job_id === newest.job_id);
    assert.ok(newestRow);
    assert.equal(newestRow.status, "queued");
    assert.equal(newestRow.kind, "xp58");
    assert.equal(newestRow.created_at, base + 120);

    // A limit smaller than the queue keeps the newest rows, not an arbitrary
    // slice — a capturing pool can never show this.
    const capped = await store.list(1);
    assert.equal(capped.length, 1);
    assert.equal(
      capped[0]?.created_at !== undefined && capped[0].created_at >= base + 120,
      true,
      "a limited page must start from the newest row in the store",
    );

    assert.notEqual(oldest.job_id, middle.job_id);
  } finally {
    await pool.end();
  }
});
