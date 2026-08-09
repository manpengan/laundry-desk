import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPgPool, resolvePgUrls, type PgPool, type PgPoolClient } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { enqueuePgOrderJob } from "./pg-print-queue.js";
import { createPgPrintJobStore } from "./pg-print-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const migrationSql = readFileSync(
  join(repoRoot, "packages/db/src/migrations/0046_print_job_request_idempotency.sql"),
  "utf8",
);
const SNAPSHOT_SHA256 = "a".repeat(64);

type PgFailure = Readonly<{ code?: string; message?: string }>;

function isPgFailure(error: unknown, code: string, message?: RegExp): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as PgFailure;
  return failure.code === code && (message === undefined || message.test(failure.message ?? ""));
}

async function expectPgFailure(
  client: PgPoolClient,
  action: () => Promise<unknown>,
  code: string,
  message?: RegExp,
): Promise<void> {
  await client.query("SAVEPOINT expected_print_idempotency_failure");
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_print_idempotency_failure");
    await client.query("RELEASE SAVEPOINT expected_print_idempotency_failure");
  }
  assert.equal(isPgFailure(caught, code, message), true);
}

async function insertLegacySignedJob(
  client: PgPoolClient,
  input: Readonly<{
    id: string;
    orderId: string;
    storeId?: string;
    sourceJobId?: string;
    kind?: "xp58" | "dl206";
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO print_jobs (
       id, org_id, store_id, order_id, ticket_no, kind, status,
       snapshot_json, snapshot_sha256, source_job_id, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
       '{}'::jsonb, $7, $8::uuid, clock_timestamp(), clock_timestamp()
     )`,
    [
      input.id,
      DEMO_ORG_ID,
      input.storeId ?? DEMO_STORE_ID,
      input.orderId,
      `LEGACY-${input.id.slice(0, 8)}`,
      input.kind ?? "xp58",
      SNAPSHOT_SHA256,
      input.sourceJobId ?? null,
    ],
  );
}

test(
  "0046 backfills singleton authority, preserves ambiguous history and guards old writers",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const pool = createPgPool({ connectionString: urls.admin });
    const client = await pool.connect();
    await seedPgTestIdentityFixture(pool);
    await client.query("BEGIN");
    try {
      await client.query("DROP TRIGGER IF EXISTS print_jobs_idempotency_guard ON print_jobs");
      await client.query("DROP INDEX IF EXISTS public.print_jobs_idempotency_key_uidx");
      await client.query(
        "ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_idempotency_key_shape_chk",
      );
      await client.query("ALTER TABLE print_jobs DROP COLUMN IF EXISTS idempotency_key");

      const uniqueRoot = { id: randomUUID(), orderId: randomUUID() };
      const duplicateRoot = { orderId: randomUUID(), ids: [randomUUID(), randomUUID()] };
      const uniqueChildSource = { id: randomUUID(), orderId: randomUUID() };
      const uniqueChild = { id: randomUUID(), orderId: randomUUID() };
      const duplicateChildSource = { id: randomUUID(), orderId: randomUUID() };
      const duplicateChildren = [randomUUID(), randomUUID()];
      const childlessSource = { id: randomUUID(), orderId: randomUUID() };
      const otherStoreId = randomUUID();

      await client.query(
        `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Idempotency Other Store', 'Asia/Shanghai',
                 clock_timestamp(), clock_timestamp())`,
        [otherStoreId, DEMO_ORG_ID, `idem-${otherStoreId.slice(0, 8)}`],
      );

      await insertLegacySignedJob(client, uniqueRoot);
      for (const id of duplicateRoot.ids) {
        await insertLegacySignedJob(client, { id, orderId: duplicateRoot.orderId });
      }
      await insertLegacySignedJob(client, uniqueChildSource);
      await insertLegacySignedJob(client, {
        ...uniqueChild,
        sourceJobId: uniqueChildSource.id,
      });
      await insertLegacySignedJob(client, duplicateChildSource);
      for (const id of duplicateChildren) {
        await insertLegacySignedJob(client, {
          id,
          orderId: randomUUID(),
          sourceJobId: duplicateChildSource.id,
        });
      }
      await insertLegacySignedJob(client, childlessSource);

      await client.query(migrationSql);
      const executePrivilege = await client.query<{ allowed: boolean }>(
        `SELECT pg_catalog.has_function_privilege(
                  'laundry_app',
                  'public.guard_print_job_idempotency()',
                  'EXECUTE'
                ) AS allowed`,
      );
      assert.equal(executePrivilege.rows[0]?.allowed, false);

      const otherStoreRoot = randomUUID();
      await insertLegacySignedJob(client, {
        id: otherStoreRoot,
        orderId: uniqueRoot.orderId,
        storeId: otherStoreId,
      });
      const sameKeyAcrossStores = await client.query<{
        store_id: string;
        idempotency_key: string;
      }>(
        `SELECT store_id::text, idempotency_key
           FROM print_jobs
          WHERE id = ANY($1::uuid[])
          ORDER BY store_id`,
        [[uniqueRoot.id, otherStoreRoot]],
      );
      assert.equal(sameKeyAcrossStores.rows.length, 2);
      assert.equal(new Set(sameKeyAcrossStores.rows.map((row) => row.idempotency_key)).size, 1);

      await client.query("SET LOCAL ROLE laundry_app");
      try {
        await client.query("SELECT set_config('app.org_id', $1, true)", [DEMO_ORG_ID]);
        await client.query("SELECT set_config('app.store_id', $1, true)", [DEMO_STORE_ID]);
        const scoped = await client.query<{ id: string }>(
          `SELECT id::text
             FROM print_jobs
            WHERE idempotency_key = $1`,
          [`root:${uniqueRoot.orderId}:xp58`],
        );
        assert.deepEqual(
          scoped.rows.map((row) => row.id),
          [uniqueRoot.id],
        );
      } finally {
        await client.query("RESET ROLE");
      }

      const rows = await client.query<{ id: string; idempotency_key: string | null }>(
        `SELECT id::text, idempotency_key
           FROM print_jobs
          WHERE id = ANY($1::uuid[])`,
        [[uniqueRoot.id, ...duplicateRoot.ids, uniqueChild.id, ...duplicateChildren]],
      );
      const keys = new Map(rows.rows.map((row) => [row.id, row.idempotency_key]));
      assert.equal(keys.get(uniqueRoot.id), `root:${uniqueRoot.orderId}:xp58`);
      assert.deepEqual(
        duplicateRoot.ids.map((id) => keys.get(id)),
        [null, null],
      );
      assert.equal(keys.get(uniqueChild.id), `child:${uniqueChildSource.id}`);
      assert.deepEqual(
        duplicateChildren.map((id) => keys.get(id)),
        [null, null],
      );

      const oldWriterRoot = { id: randomUUID(), orderId: randomUUID() };
      await insertLegacySignedJob(client, oldWriterRoot);
      const derivedRoot = await client.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM print_jobs WHERE id = $1::uuid",
        [oldWriterRoot.id],
      );
      assert.equal(derivedRoot.rows[0]?.idempotency_key, `root:${oldWriterRoot.orderId}:xp58`);

      const oldWriterChild = { id: randomUUID(), orderId: randomUUID() };
      await insertLegacySignedJob(client, {
        ...oldWriterChild,
        sourceJobId: childlessSource.id,
      });
      const derivedChild = await client.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM print_jobs WHERE id = $1::uuid",
        [oldWriterChild.id],
      );
      assert.equal(derivedChild.rows[0]?.idempotency_key, `child:${childlessSource.id}`);

      await expectPgFailure(
        client,
        () => insertLegacySignedJob(client, { id: randomUUID(), orderId: uniqueRoot.orderId }),
        "23505",
      );
      await expectPgFailure(
        client,
        () =>
          insertLegacySignedJob(client, {
            id: randomUUID(),
            orderId: duplicateRoot.orderId,
          }),
        "23514",
        /authority is ambiguous/u,
      );
      await expectPgFailure(
        client,
        () =>
          insertLegacySignedJob(client, {
            id: randomUUID(),
            orderId: randomUUID(),
            sourceJobId: duplicateChildSource.id,
          }),
        "23514",
        /authority is ambiguous/u,
      );
      await expectPgFailure(
        client,
        () =>
          client.query(
            `INSERT INTO print_jobs (
               id, org_id, store_id, order_id, ticket_no, kind, status,
               snapshot_json, snapshot_sha256, idempotency_key, created_at, updated_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'BAD-KEY', 'xp58', 'queued',
                       '{}'::jsonb, $5, 'child:not-the-binding', clock_timestamp(), clock_timestamp())`,
            [randomUUID(), DEMO_ORG_ID, DEMO_STORE_ID, randomUUID(), SNAPSHOT_SHA256],
          ),
        "23514",
        /does not match its binding/u,
      );
      await expectPgFailure(
        client,
        () =>
          client.query(
            "UPDATE print_jobs SET idempotency_key = idempotency_key || ':changed' WHERE id = $1::uuid",
            [uniqueRoot.id],
          ),
        "23514",
        /idempotency key is immutable/u,
      );

      const diagnosticId = randomUUID();
      await client.query(
        `INSERT INTO print_jobs (
           id, org_id, store_id, order_id, ticket_no, kind, status, created_at, updated_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DIAGNOSTIC', 'xp58', 'queued',
                   clock_timestamp(), clock_timestamp())`,
        [diagnosticId, DEMO_ORG_ID, DEMO_STORE_ID, uniqueRoot.orderId],
      );
      const diagnostic = await client.query<{ idempotency_key: string | null }>(
        "SELECT idempotency_key FROM print_jobs WHERE id = $1::uuid",
        [diagnosticId],
      );
      assert.equal(diagnostic.rows[0]?.idempotency_key, null);

      await assert.rejects(
        () =>
          enqueuePgOrderJob(
            client,
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            { order_id: duplicateRoot.orderId, kind: "xp58" },
            randomUUID,
          ),
        /PRINT_JOB_IDEMPOTENCY_AUTHORITY_AMBIGUOUS/u,
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);

type RuntimeFixture = Readonly<{
  adminPool: PgPool;
  appPool: PgPool;
  deviceId: string;
  orderIds: string[];
  jobIds: string[];
  close(): Promise<void>;
}>;

async function createRuntimeFixture(): Promise<RuntimeFixture> {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app, max: 8 });
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ type: "spki", format: "der" });
  const deviceId = randomUUID();
  const orderIds: string[] = [];
  const jobIds: string[] = [];
  await seedPgTestIdentityFixture(adminPool);
  await adminPool.query(
    `INSERT INTO edge_devices (
       org_id, store_id, device_id, public_key_spki, public_key_fingerprint,
       status, paired_by_staff_id, paired_at, last_seen_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'paired', $6::uuid,
               clock_timestamp(), clock_timestamp())`,
    [
      DEMO_ORG_ID,
      DEMO_STORE_ID,
      deviceId,
      spki.toString("base64url"),
      createHash("sha256").update(spki).digest("hex"),
      DEMO_ADMIN_ID,
    ],
  );
  return Object.freeze({
    adminPool,
    appPool,
    deviceId,
    orderIds,
    jobIds,
    close: async () => {
      try {
        if (jobIds.length > 0) {
          await adminPool.query("DELETE FROM print_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
        }
        if (orderIds.length > 0) {
          await adminPool.query("DELETE FROM payments WHERE order_id = ANY($1::uuid[])", [
            orderIds,
          ]);
          await adminPool.query("DELETE FROM order_lines WHERE order_id = ANY($1::uuid[])", [
            orderIds,
          ]);
          await adminPool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [orderIds]);
        }
        await adminPool.query("DELETE FROM edge_devices WHERE device_id = $1::uuid", [deviceId]);
      } finally {
        await Promise.all([appPool.end(), adminPool.end()]);
      }
    },
  });
}

async function seedOrder(
  fixture: RuntimeFixture,
): Promise<Readonly<{ id: string; ticket: string }>> {
  const id = randomUUID();
  const ticket = `IDEM-${id.slice(0, 8)}`;
  fixture.orderIds.push(id);
  await fixture.adminPool.query(
    `INSERT INTO orders (
       id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
       subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents,
       freight_cents, payable_cents, paid_cents, balance_cents,
       created_at, updated_at, created_by_staff_id, business_date
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, 'open', NULL, NULL, NULL,
       500, 500, 0, 0, 0, 0, 500, 0, 500,
       clock_timestamp(), clock_timestamp(), $5::uuid, '2026-08-10'
     )`,
    [id, DEMO_ORG_ID, DEMO_STORE_ID, ticket, DEMO_ADMIN_ID],
  );
  await fixture.adminPool.query(
    `INSERT INTO order_lines (
       id, org_id, store_id, order_id, line_index, service_code, category_code,
       unit_price_cents, qty, line_total_cents, color, brand
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0,
               'wash', 'shirt', 500, 1, 500, NULL, NULL)`,
    [randomUUID(), DEMO_ORG_ID, DEMO_STORE_ID, id],
  );
  return Object.freeze({ id, ticket });
}

async function seedTerminalSource(
  fixture: RuntimeFixture,
  status: "done" | "failed",
  receiptSequence: number,
): Promise<Readonly<{ id: string; orderId: string }>> {
  const order = await seedOrder(fixture);
  const id = randomUUID();
  fixture.jobIds.push(id);
  const receiptResult = status === "done" ? "succeeded" : "failed";
  await fixture.adminPool.query(
    `INSERT INTO print_jobs (
       id, org_id, store_id, order_id, ticket_no, kind, status,
       snapshot_json, snapshot_sha256,
       dispatch_device_id, dispatch_staff_id, ticket_nonce, capability_json,
       dispatch_issued_at, dispatch_expires_at,
       receipt_seq, receipt_result, cups_job_id, receipt_at, receipt_json,
       receipt_envelope_sha256, settled_at, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'xp58', $6,
       '{}'::jsonb, $7,
       $8::uuid, $9::uuid, $10::uuid, '{}'::jsonb,
       '2026-08-10T00:00:00.000Z', '2026-08-10T00:05:00.000Z',
       $11, $12, $13, '2026-08-10T00:00:01.000Z', '{}'::jsonb,
       $14, '2026-08-10T00:00:01.000Z',
       '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:01.000Z'
     )`,
    [
      id,
      DEMO_ORG_ID,
      DEMO_STORE_ID,
      order.id,
      order.ticket,
      status,
      SNAPSHOT_SHA256,
      fixture.deviceId,
      DEMO_ADMIN_ID,
      randomUUID(),
      receiptSequence,
      receiptResult,
      status === "done" ? `xp58-${receiptSequence}` : null,
      "b".repeat(64),
    ],
  );
  return Object.freeze({ id, orderId: order.id });
}

function createStore(fixture: RuntimeFixture, ids: string[]) {
  return createPgPrintJobStore(fixture.appPool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    newId: () => {
      const id = randomUUID();
      ids.push(id);
      return id;
    },
  });
}

async function enqueueRootUnderRepeatableRead(
  fixture: RuntimeFixture,
  candidateIds: string[],
  orderId: string,
) {
  const client = await fixture.appPool.connect();
  const store = createStore(fixture, candidateIds);
  const enqueue = store.enqueueFromOrder;
  assert.ok(enqueue);
  try {
    return await withTenantTransaction(
      client,
      { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID, staffId: DEMO_ADMIN_ID },
      () => enqueue.call(store, { order_id: orderId, kind: "xp58" }),
      { isolation: "repeatable_read" },
    );
  } finally {
    client.release();
  }
}

async function lockPrintJobInserts(fixture: RuntimeFixture) {
  const blocker = await fixture.adminPool.connect();
  await blocker.query("BEGIN");
  await blocker.query("LOCK TABLE public.print_jobs IN SHARE MODE");
  let finished = false;

  async function finish(sql: "COMMIT" | "ROLLBACK"): Promise<void> {
    if (finished) return;
    finished = true;
    try {
      await blocker.query(sql);
    } finally {
      blocker.release();
    }
  }

  return Object.freeze({
    waitForBlockedInserts: async (expected: number): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await fixture.adminPool.query<{ count: number }>(
          `SELECT count(*)::integer AS count
             FROM pg_catalog.pg_stat_activity
            WHERE datname = current_database()
              AND state = 'active'
              AND wait_event_type = 'Lock'
              AND query LIKE '%INSERT INTO print_jobs%'`,
        );
        if ((waiting.rows[0]?.count ?? 0) >= expected) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("TIMED_OUT_WAITING_FOR_BLOCKED_PRINT_INSERTS");
    },
    release: () => finish("COMMIT"),
    abort: () => finish("ROLLBACK"),
  });
}

test(
  "real PG replays committed roots and serializes concurrent root creation",
  { skip: urls === null },
  async () => {
    const fixture = await createRuntimeFixture();
    try {
      const firstOrder = await seedOrder(fixture);
      const candidateIds: string[] = [];
      const firstStore = createStore(fixture, candidateIds);
      const first = await firstStore.enqueueFromOrder?.({ order_id: firstOrder.id, kind: "xp58" });
      assert.ok(first);
      fixture.jobIds.push(first.job_id);
      await fixture.adminPool.query(
        `UPDATE print_jobs
            SET error = 'committed-response-lost', updated_at = '2026-08-10T01:00:00.000Z'
          WHERE id = $1::uuid`,
        [first.job_id],
      );
      await fixture.adminPool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1::uuid", [
        firstOrder.id,
      ]);
      const replay = await createStore(fixture, candidateIds).enqueueFromOrder?.({
        order_id: firstOrder.id,
        kind: "xp58",
      });
      assert.ok(replay);
      assert.equal(replay.job_id, first.job_id);
      assert.equal(replay.error, "committed-response-lost");
      assert.equal(replay.updated_at, 1_786_323_600);

      const concurrentOrder = await seedOrder(fixture);
      const candidateBaseline = candidateIds.length;
      const barrier = await lockPrintJobInserts(fixture);
      const attemptsPromise = Promise.allSettled([
        enqueueRootUnderRepeatableRead(fixture, candidateIds, concurrentOrder.id),
        enqueueRootUnderRepeatableRead(fixture, candidateIds, concurrentOrder.id),
      ]);
      try {
        await barrier.waitForBlockedInserts(2);
        assert.equal(candidateIds.length, candidateBaseline + 2);
        await barrier.release();
      } catch (error) {
        await barrier.abort();
        await attemptsPromise;
        throw error;
      }
      const attempts = await attemptsPromise;
      const successful = attempts.flatMap((attempt) =>
        attempt.status === "fulfilled" && attempt.value !== undefined ? [attempt.value] : [],
      );
      assert.equal(successful.length, 1);
      fixture.jobIds.push(successful[0]!.job_id);
      const rejected = attempts.filter((attempt) => attempt.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.equal(isPgFailure(rejected[0]?.reason, "40001"), true);
      const persisted = await fixture.adminPool.query<{ id: string }>(
        `SELECT id::text FROM print_jobs
          WHERE org_id = $1::uuid AND store_id = $2::uuid
            AND order_id = $3::uuid AND kind = 'xp58'
            AND source_job_id IS NULL AND snapshot_sha256 IS NOT NULL`,
        [DEMO_ORG_ID, DEMO_STORE_ID, concurrentOrder.id],
      );
      assert.equal(persisted.rows.length, 1);
    } finally {
      await fixture.close();
    }
  },
);

test(
  "real PG replays and serializes retry/reprint children with exact lineage",
  { skip: urls === null },
  async () => {
    const fixture = await createRuntimeFixture();
    try {
      const retrySource = await seedTerminalSource(fixture, "failed", 1);
      const reprintSource = await seedTerminalSource(fixture, "done", 2);
      const candidateIds: string[] = [];
      const candidateBaseline = candidateIds.length;
      const barrier = await lockPrintJobInserts(fixture);
      const retryPromise = Promise.allSettled([
        createStore(fixture, candidateIds).requeueFromSource?.({
          source_job_id: retrySource.id,
          action: "retry",
        }),
        createStore(fixture, candidateIds).requeueFromSource?.({
          source_job_id: retrySource.id,
          action: "retry",
        }),
      ]);
      try {
        await barrier.waitForBlockedInserts(2);
        assert.equal(candidateIds.length, candidateBaseline + 2);
        await barrier.release();
      } catch (error) {
        await barrier.abort();
        await retryPromise;
        throw error;
      }
      const retrySettled = await retryPromise;
      assert.equal(
        retrySettled.every((attempt) => attempt.status === "fulfilled"),
        true,
      );
      const retryAttempts = retrySettled.flatMap((attempt) =>
        attempt.status === "fulfilled" && attempt.value !== undefined ? [attempt.value] : [],
      );
      assert.ok(retryAttempts[0]);
      assert.ok(retryAttempts[1]);
      assert.equal(retryAttempts[0].job_id, retryAttempts[1].job_id);
      fixture.jobIds.push(retryAttempts[0].job_id);

      const firstReprint = await createStore(fixture, candidateIds).requeueFromSource?.({
        source_job_id: reprintSource.id,
        action: "reprint",
      });
      assert.ok(firstReprint);
      fixture.jobIds.push(firstReprint.job_id);
      await fixture.adminPool.query(
        `UPDATE print_jobs
            SET error = 'committed-response-lost', updated_at = '2026-08-10T02:00:00.000Z'
          WHERE id = $1::uuid`,
        [firstReprint.job_id],
      );
      const replayedReprint = await createStore(fixture, candidateIds).requeueFromSource?.({
        source_job_id: reprintSource.id,
        action: "reprint",
      });
      assert.ok(replayedReprint);
      assert.equal(replayedReprint.job_id, firstReprint.job_id);
      assert.equal(replayedReprint.error, "committed-response-lost");
      const wrongActionStore = createStore(fixture, candidateIds);
      const requeueWrongAction = wrongActionStore.requeueFromSource;
      assert.ok(requeueWrongAction);
      await assert.rejects(
        () =>
          requeueWrongAction.call(wrongActionStore, {
            source_job_id: reprintSource.id,
            action: "retry",
          }),
        /not retry eligible/u,
      );

      const children = await fixture.adminPool.query<{ source_job_id: string; count: string }>(
        `SELECT source_job_id::text, count(*)::text AS count
           FROM print_jobs
          WHERE source_job_id = ANY($1::uuid[])
          GROUP BY source_job_id`,
        [[retrySource.id, reprintSource.id]],
      );
      assert.deepEqual(
        new Map(children.rows.map((row) => [row.source_job_id, row.count])),
        new Map([
          [retrySource.id, "1"],
          [reprintSource.id, "1"],
        ]),
      );
    } finally {
      await fixture.close();
    }
  },
);
