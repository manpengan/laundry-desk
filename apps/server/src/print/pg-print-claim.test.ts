/**
 * Real-PostgreSQL acceptance for the mock print worker lease (product design §7).
 *
 * Claim atomicity cannot be shown with a capturing pool: SKIP LOCKED only means
 * anything against a real transaction manager. These cases run concurrent
 * claimers and prove that neither expired nor signed authoritative rows are
 * ever re-submitted by the legacy diagnostic worker.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgPrintJobStore } from "./pg-print-store.js";
import { processXp58PrintJob } from "./process-xp58.js";
import { hashPrintSnapshot } from "./snapshot.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT = Object.freeze({ orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID });

function createStore(pool: PgPool) {
  return createPgPrintJobStore(pool, TENANT);
}

async function enqueueTicket(store: ReturnType<typeof createStore>, now: number) {
  return store.enqueue({
    order_id: randomUUID(),
    ticket_no: `claim-${randomUUID().slice(0, 8)}`,
    kind: "xp58",
    now,
  });
}

/**
 * Claiming takes the oldest claimable job in the store, so anything a previous
 * case left behind would be handed out first. Retire the queue before each case
 * to keep them order-independent on the shared integration database.
 */
async function drainQueue(store: ReturnType<typeof createStore>, now: number): Promise<void> {
  for (let guard = 0; guard < 100; guard += 1) {
    const claim = await store.claimNext?.({ worker_id: "drain", max_attempts: 1_000_000, now });
    if (claim === null || claim === undefined) return;
    await store.transition(claim.job_id, "done", { now });
  }
  throw new Error("print queue did not drain");
}

maybe("concurrent workers never claim the same print job", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });
  try {
    const store = createStore(pool);
    assert.ok(store.claimNext, "PG store must support claiming");
    const now = 1_800_000_000;
    await drainQueue(store, now);
    const first = await enqueueTicket(store, now);
    const second = await enqueueTicket(store, now);

    // Six workers race for two jobs.
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.claimNext?.({ worker_id: `worker-${index}`, now }),
      ),
    );
    const won = claims.filter((claim) => claim !== null && claim !== undefined);
    const claimedIds = won.map((claim) => claim?.job_id);

    assert.equal(won.length, 2, "exactly the two queued jobs may be claimed");
    assert.equal(new Set(claimedIds).size, 2, "a job must never be handed to two workers");
    assert.deepEqual([...claimedIds].sort(), [first.job_id, second.job_id].sort());
    for (const claim of won) {
      assert.equal(claim?.attempt_count, 1);
      assert.equal(claim?.lease_until, now + 30);
    }
  } finally {
    await pool.end();
  }
});

maybe("an expired diagnostic lease is never reclaimed automatically", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });
  try {
    const store = createStore(pool);
    const now = 1_800_100_000;
    await drainQueue(store, now);
    const job = await enqueueTicket(store, now);

    const held = await store.claimNext?.({ worker_id: "worker-a", lease_seconds: 30, now });
    assert.equal(held?.job_id, job.job_id);

    // While the lease is live nobody else may take it.
    assert.equal(
      await store.claimNext?.({ worker_id: "worker-b", now: now + 5 }),
      null,
      "a live lease must block other workers",
    );

    // Expiry is not evidence that no physical submission happened.
    const recovered = await store.claimNext?.({ worker_id: "worker-b", now: now + 31 });
    assert.equal(recovered, null);
    assert.equal((await store.get(job.job_id))?.status, "printing");
    assert.equal((await store.get(job.job_id))?.updated_at, now);
  } finally {
    await pool.end();
  }
});

maybe("finishing a job records its artifact and releases the lease", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });
  try {
    const store = createStore(pool);
    const now = 1_800_300_000;
    await drainQueue(store, now);
    const job = await enqueueTicket(store, now);
    const claim = await store.claimNext?.({ worker_id: "w-artifact", now });
    assert.equal(claim?.job_id, job.job_id);

    const artifact = Object.freeze({
      path: `${job.job_id}-xp58-0001.txt`,
      sha256: "a".repeat(64),
      bytes: 128,
    });
    await store.transition(job.job_id, "done", { now: now + 1, artifact });

    // RLS needs the tenant GUCs; a raw pool query returns nothing.
    const rows = await withStoreGucOrCurrent(pool, TENANT, (client) =>
      client.query<{
        artifact_path: string | null;
        artifact_sha256: string | null;
        artifact_bytes: number | null;
        completed_at: Date | null;
        worker_id: string | null;
        lease_until: Date | null;
      }>(
        `SELECT artifact_path, artifact_sha256, artifact_bytes, completed_at, worker_id, lease_until
         FROM print_jobs WHERE id = $1::uuid`,
        [job.job_id],
      ),
    );
    const row = rows.rows[0];
    assert.ok(row);
    assert.equal(row.artifact_path, artifact.path);
    assert.equal(row.artifact_sha256, artifact.sha256);
    assert.equal(row.artifact_bytes, 128);
    assert.notEqual(row.completed_at, null, "a done job must record when it completed");
    assert.equal(row.worker_id, null, "a terminal job must not keep holding a lease");
    assert.equal(row.lease_until, null);

    // The finished job must not come back around to another worker.
    assert.equal(await store.claimNext?.({ worker_id: "w-after", now: now + 999 }), null);
  } finally {
    await pool.end();
  }
});

maybe("a signed snapshot cannot enter the legacy claim or process path", async () => {
  assert.ok(urls);
  const pool = createPgPool({ connectionString: urls.app });
  try {
    const store = createStore(pool);
    const now = 1_800_200_000;
    await drainQueue(store, now);
    const jobId = randomUUID();
    const orderId = randomUUID();
    const snapshot = Object.freeze({
      version: 1 as const,
      store_name: "Signed test",
      store_phone: null,
      order_id: orderId,
      ticket_no: `signed-${jobId.slice(0, 8)}`,
      received_at: new Date(now * 1_000).toISOString(),
      customer_name: null,
      customer_phone: null,
      note: null,
      lines: Object.freeze([
        Object.freeze({
          line_index: 0,
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 100,
          qty: 1,
          line_total_cents: 100,
          color: null,
          brand: null,
        }),
      ]),
      totals: Object.freeze({
        original_cents: 100,
        discount_cents: 0,
        addon_cents: 0,
        urgent_cents: 0,
        freight_cents: 0,
        payable_cents: 100,
        paid_cents: 100,
        balance_cents: 0,
      }),
      payment_methods: Object.freeze(["cash" as const]),
    });
    await withStoreGucOrCurrent(pool, TENANT, (client) =>
      client.query(
        `INSERT INTO print_jobs (
           id, org_id, store_id, order_id, ticket_no, kind, status,
           snapshot_json, snapshot_sha256, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'xp58', 'queued',
                   $6::jsonb, $7, $8, $8)`,
        [
          jobId,
          TENANT.orgId,
          TENANT.storeId,
          orderId,
          snapshot.ticket_no,
          JSON.stringify(snapshot),
          hashPrintSnapshot(snapshot),
          new Date(now * 1_000),
        ],
      ),
    );

    assert.equal(await store.claimJob?.(jobId, { worker_id: "legacy", now }), null);
    await assert.rejects(
      () => processXp58PrintJob(store, jobId, { now }),
      /requires a verified device receipt/u,
    );
    assert.equal((await store.get(jobId))?.status, "queued");
  } finally {
    await pool.end();
  }
});
