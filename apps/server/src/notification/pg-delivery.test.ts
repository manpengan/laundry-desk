import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createSessionSqlClient, withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createPgCustomerPrivacyOperations } from "../customer/pg-customer-privacy-store.js";
import { createSoftwareOnlyNotificationProvider } from "./delivery-provider.js";
import type { NotificationProvider } from "./delivery-types.js";
import { runNotificationWorkerOnce } from "./delivery-worker.js";
import { createPgNotificationDeliveryStore } from "./pg-delivery-store.js";
import {
  claimReadyAt,
  deferred,
  enqueueNotificationBatch as enqueue,
  makeNotificationBatchReady,
  seedNotificationCandidate as seedCandidate,
  seedExpiredNotificationClaim,
  seedNotificationTenant as seedTenant,
  waitForOrderLock,
} from "./pg-delivery-test-fixture.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

maybe("real PG outbox preserves leases, evidence, cost, RLS and privacy lock order", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app, max: 8 });
  try {
    const fixture = await seedTenant(adminPool);
    const deliveryStore = createPgNotificationDeliveryStore(appPool);
    const firstNow = new Date();
    const first = await seedCandidate(appPool, fixture, 1, firstNow);
    const firstBatch = await enqueue(appPool, fixture, first.orderId, firstNow, deliveryStore);
    const firstClaimAt = await claimReadyAt(adminPool, firstBatch.batch_id);

    const raw = await adminPool.query<Readonly<{ recipient_hmac: string; message_sha256: string }>>(
      `SELECT recipient_hmac, message_sha256
         FROM notification_deliveries WHERE batch_id = $1::uuid`,
      [firstBatch.batch_id],
    );
    assert.equal(raw.rows.length, 1);
    assert.match(raw.rows[0]?.recipient_hmac ?? "", /^[0-9a-f]{64}$/u);
    assert.match(raw.rows[0]?.message_sha256 ?? "", /^[0-9a-f]{64}$/u);
    assert.notEqual(raw.rows[0]?.recipient_hmac, sha256(first.phone));
    assert.doesNotMatch(
      JSON.stringify(raw.rows),
      new RegExp(`${first.phone}|Notification Customer`, "u"),
    );

    const claims = await Promise.all([
      deliveryStore.claimNext(fixture.tenant, "worker:a", firstClaimAt),
      deliveryStore.claimNext(fixture.tenant, "worker:b", firstClaimAt),
    ]);
    const firstClaim = claims.find((claim) => claim !== null);
    assert.ok(firstClaim);
    assert.equal(claims.filter((claim) => claim !== null).length, 1);
    assert.equal(firstClaim.deliveryId.length, 36);
    assert.equal(
      await deliveryStore.claimNext(
        fixture.tenant,
        "worker:future-clock",
        new Date(firstClaimAt.getTime() + 365 * 24 * 60 * 60 * 1_000),
      ),
      null,
    );
    const receipt = Object.freeze({
      deliveryId: firstClaim.deliveryId,
      providerCode: "software_only_fake",
      receiptId: "receipt:first",
      status: "delivered" as const,
      observedAt: new Date(firstClaimAt.getTime() + 500),
      recordedAt: new Date(firstClaimAt.getTime() + 600),
    });
    assert.equal(
      await deliveryStore.applyReceipt(fixture.tenant, {
        ...receipt,
        providerCode: "wrong_provider",
        receiptId: "receipt:wrong-provider",
      }),
      "ignored",
    );
    assert.equal(await deliveryStore.applyReceipt(fixture.tenant, receipt), "pending");
    assert.equal(
      await deliveryStore.settleAttempt(fixture.tenant, {
        deliveryId: firstClaim.deliveryId,
        leaseToken: firstClaim.leaseToken,
        attemptNo: firstClaim.attemptNo,
        outcome: "accepted",
        errorCode: null,
        providerRefSha256: sha256("provider:first"),
        costCents: 0,
        startedAt: firstClaimAt,
        completedAt: new Date(firstClaimAt.getTime() + 1_000),
      }),
      "accepted",
    );
    assert.equal(await deliveryStore.applyReceipt(fixture.tenant, receipt), "duplicate");
    assert.equal(
      await deliveryStore.applyReceipt(fixture.tenant, {
        ...receipt,
        receiptId: "receipt:late-failure",
        status: "failed",
      }),
      "ignored",
    );

    await adminPool.query("BEGIN");
    try {
      const duplicateBatchId = randomUUID();
      await adminPool.query(
        `INSERT INTO notification_delivery_batches (
           id, org_id, store_id, provider_code, assurance, channel,
           template_id, template_code, template_version, min_age_days,
           unpaid_only, garment_statuses, recipient_count, estimated_cost_cents,
           max_cost_cents, created_by_staff_id, created_at
         ) SELECT $1::uuid, org_id, store_id, provider_code, assurance, channel,
                  template_id, template_code, template_version, min_age_days,
                  unpaid_only, garment_statuses, recipient_count, estimated_cost_cents,
                  max_cost_cents, created_by_staff_id, now()
             FROM notification_delivery_batches WHERE id = $2::uuid`,
        [duplicateBatchId, firstBatch.batch_id],
      );
      await assert.rejects(
        () =>
          adminPool.query(
            `INSERT INTO notification_deliveries (
               id, org_id, store_id, batch_id, order_id, customer_id, status,
               recipient_hmac, message_sha256, attempt_count, next_attempt_at,
               cost_cents, created_at, updated_at
             ) SELECT gen_random_uuid(), org_id, store_id, $1::uuid, order_id, customer_id,
                      'queued', customer_phone_hmac(org_id, $2), $3, 0, now(), 0, now(), now()
                 FROM notification_deliveries WHERE id = $4::uuid`,
            [duplicateBatchId, first.phone, sha256("duplicate-message"), firstClaim.deliveryId],
          ),
        /notification_deliveries_order_uidx/iu,
      );
    } finally {
      await adminPool.query("ROLLBACK");
    }

    const retryNow = new Date(firstNow.getTime() + 10_000);
    const retryCandidate = await seedCandidate(appPool, fixture, 2, retryNow);
    const retryBatch = await enqueue(
      appPool,
      fixture,
      retryCandidate.orderId,
      retryNow,
      deliveryStore,
    );
    const sentIds: string[] = [];
    let workerNow = await claimReadyAt(adminPool, retryBatch.batch_id);
    const software = createSoftwareOnlyNotificationProvider();
    const retryProvider: NotificationProvider = Object.freeze({
      ...software,
      send: async (input) => {
        sentIds.push(input.deliveryId);
        return sentIds.length === 1
          ? Object.freeze({
              outcome: "transient_failure" as const,
              errorCode: "PROVIDER_BUSY",
              providerRef: null,
              costCents: 0,
            })
          : software.send(input);
      },
    });
    const firstRetry = await runNotificationWorkerOnce({
      store: deliveryStore,
      provider: retryProvider,
      tenant: fixture.tenant,
      workerId: "worker:retry",
      now: () => workerNow,
    });
    assert.equal(firstRetry.kind, "retry_wait");
    await makeNotificationBatchReady(adminPool, retryBatch.batch_id);
    workerNow = new Date(workerNow.getTime() + 60_000);
    const secondRetry = await runNotificationWorkerOnce({
      store: deliveryStore,
      provider: retryProvider,
      tenant: fixture.tenant,
      workerId: "worker:retry",
      now: () => workerNow,
    });
    assert.equal(secondRetry.kind, "accepted");
    assert.deepEqual(sentIds, [sentIds[0], sentIds[0]]);

    const crashNow = new Date(workerNow.getTime() + 5_000);
    const crashCandidate = await seedCandidate(appPool, fixture, 7, crashNow);
    const crashBatch = await enqueue(
      appPool,
      fixture,
      crashCandidate.orderId,
      crashNow,
      deliveryStore,
    );
    const abandonedDeliveryId = await seedExpiredNotificationClaim(
      adminPool,
      crashBatch.batch_id,
      1,
    );
    const crashClaimAt = new Date();
    const reclaimed = await deliveryStore.claimNext(
      fixture.tenant,
      "worker:reclaimed",
      crashClaimAt,
    );
    assert.equal(reclaimed?.deliveryId, abandonedDeliveryId);
    assert.equal(reclaimed?.attemptNo, 2);
    assert.ok(reclaimed);
    await deliveryStore.settleAttempt(fixture.tenant, {
      deliveryId: reclaimed.deliveryId,
      leaseToken: reclaimed.leaseToken,
      attemptNo: reclaimed.attemptNo,
      outcome: "permanent_failure",
      errorCode: "TEST_MANUAL_FALLBACK",
      providerRefSha256: null,
      costCents: 0,
      startedAt: crashClaimAt,
      completedAt: new Date(crashClaimAt.getTime() + 1),
    });
    const abandonedAttempts = await adminPool.query<
      Readonly<{ attempt_no: number; outcome: string; error_code: string | null }>
    >(
      `SELECT attempt_no, outcome, error_code
         FROM notification_delivery_attempts
        WHERE delivery_id = $1::uuid ORDER BY attempt_no`,
      [abandonedDeliveryId],
    );
    assert.deepEqual(
      abandonedAttempts.rows.map((attempt) => [
        attempt.attempt_no,
        attempt.outcome,
        attempt.error_code,
      ]),
      [
        [1, "uncertain", "PROVIDER_LEASE_EXPIRED"],
        [2, "permanent_failure", "TEST_MANUAL_FALLBACK"],
      ],
    );

    const costNow = new Date(workerNow.getTime() + 10_000);
    const costCandidate = await seedCandidate(appPool, fixture, 3, costNow);
    const costBatch = await enqueue(
      appPool,
      fixture,
      costCandidate.orderId,
      costNow,
      deliveryStore,
    );
    const costClaimAt = await claimReadyAt(adminPool, costBatch.batch_id);
    const costClaim = await deliveryStore.claimNext(fixture.tenant, "worker:cost", costClaimAt);
    assert.ok(costClaim);
    assert.equal(
      await deliveryStore.settleAttempt(fixture.tenant, {
        deliveryId: costClaim.deliveryId,
        leaseToken: costClaim.leaseToken,
        attemptNo: costClaim.attemptNo,
        outcome: "accepted",
        errorCode: null,
        providerRefSha256: sha256("provider:unexpected-cost"),
        costCents: 1,
        startedAt: costClaimAt,
        completedAt: new Date(costClaimAt.getTime() + 1_000),
      }),
      "manual_required",
    );

    const activeNow = new Date();
    const activeCandidate = await seedCandidate(appPool, fixture, 4, activeNow);
    const activeBatch = await enqueue(
      appPool,
      fixture,
      activeCandidate.orderId,
      activeNow,
      deliveryStore,
    );
    const activeClaimAt = await claimReadyAt(adminPool, activeBatch.batch_id);
    const activeClaim = await deliveryStore.claimNext(
      fixture.tenant,
      "worker:privacy",
      activeClaimAt,
    );
    assert.ok(activeClaim);
    await assert.rejects(
      () =>
        withPoolClient(appPool, (client) =>
          withTenantTransaction(client, fixture.tenant, (tx) =>
            tx.query(
              `UPDATE orders SET customer_pii_purged_at = now()
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [fixture.tenant.orgId, fixture.tenant.storeId, activeCandidate.orderId],
            ),
          ),
        ),
      /CUSTOMER_NOTIFICATION_IN_FLIGHT/u,
    );
    await deliveryStore.settleAttempt(fixture.tenant, {
      deliveryId: activeClaim.deliveryId,
      leaseToken: activeClaim.leaseToken,
      attemptNo: activeClaim.attemptNo,
      outcome: "permanent_failure",
      errorCode: "TEST_MANUAL_FALLBACK",
      providerRefSha256: null,
      costCents: 0,
      startedAt: activeClaimAt,
      completedAt: new Date(activeClaimAt.getTime() + 1),
    });

    const expiredNow = new Date(Date.now() - 120_000);
    const expiredCandidate = await seedCandidate(appPool, fixture, 5, expiredNow);
    const expiredBatch = await enqueue(
      appPool,
      fixture,
      expiredCandidate.orderId,
      expiredNow,
      deliveryStore,
    );
    await seedExpiredNotificationClaim(adminPool, expiredBatch.batch_id, 1);
    await withPoolClient(appPool, (client) =>
      withTenantTransaction(client, fixture.tenant, (tx) =>
        tx.query(
          `UPDATE orders SET customer_pii_purged_at = now()
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [fixture.tenant.orgId, fixture.tenant.storeId, expiredCandidate.orderId],
        ),
      ),
    );

    const raceNow = new Date();
    const raceCandidate = await seedCandidate(appPool, fixture, 6, raceNow);
    const raceBatch = await enqueue(
      appPool,
      fixture,
      raceCandidate.orderId,
      raceNow,
      deliveryStore,
    );
    const raceClaimAt = await claimReadyAt(adminPool, raceBatch.batch_id);
    const privacyClient = await appPool.connect();
    const privacyLocked = deferred();
    const releasePrivacy = deferred();
    try {
      const privacy = withTenantTransaction(
        createSessionSqlClient(privacyClient),
        fixture.tenant,
        async (tx) => {
          await tx.query(
            `SELECT id FROM orders
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              FOR UPDATE`,
            [fixture.tenant.orgId, fixture.tenant.storeId, raceCandidate.orderId],
          );
          privacyLocked.resolve();
          await releasePrivacy.promise;
          await tx.query(
            `UPDATE orders SET customer_pii_purged_at = now()
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
            [fixture.tenant.orgId, fixture.tenant.storeId, raceCandidate.orderId],
          );
        },
      );
      await privacyLocked.promise;
      const racingClaim = deliveryStore.claimNext(fixture.tenant, "worker:race", raceClaimAt);
      await waitForOrderLock(adminPool);
      releasePrivacy.resolve();
      await privacy;
      assert.equal(await racingClaim, null);
    } finally {
      releasePrivacy.resolve();
      privacyClient.release();
    }

    const evidence = await adminPool.query<
      Readonly<{
        order_id: string;
        status: string;
        recipient_hmac: string | null;
        message_sha256: string | null;
        last_error_code: string | null;
        cost_cents: number;
      }>
    >(
      `SELECT order_id, status, recipient_hmac, message_sha256,
              last_error_code, cost_cents
         FROM notification_deliveries
        WHERE org_id = $1::uuid AND store_id = $2::uuid
        ORDER BY created_at, id`,
      [fixture.tenant.orgId, fixture.tenant.storeId],
    );
    const byOrder = new Map(evidence.rows.map((row) => [row.order_id, row]));
    assert.equal(byOrder.get(first.orderId)?.status, "delivered");
    assert.equal(byOrder.get(retryCandidate.orderId)?.status, "accepted");
    assert.equal(byOrder.get(costCandidate.orderId)?.status, "manual_required");
    assert.equal(byOrder.get(costCandidate.orderId)?.last_error_code, "COST_LIMIT_EXCEEDED");
    assert.equal(byOrder.get(costCandidate.orderId)?.cost_cents, 1);
    assert.equal(byOrder.get(expiredCandidate.orderId)?.status, "cancelled");
    assert.equal(byOrder.get(raceCandidate.orderId)?.status, "cancelled");
    for (const orderId of [first.orderId, costCandidate.orderId, expiredCandidate.orderId]) {
      assert.equal(byOrder.get(orderId)?.recipient_hmac, null);
      assert.equal(byOrder.get(orderId)?.message_sha256, null);
    }
    const attempts = await adminPool.query<Readonly<{ attempt_no: number }>>(
      `SELECT attempt_no FROM notification_delivery_attempts
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND delivery_id = $3::uuid ORDER BY attempt_no`,
      [fixture.tenant.orgId, fixture.tenant.storeId, sentIds[0]],
    );
    assert.deepEqual(
      attempts.rows.map((row) => row.attempt_no),
      [1, 2],
    );

    const privacy = createPgCustomerPrivacyOperations(appPool, fixture.tenant.orgId);
    const exported = await privacy.exportPrivacy({
      customer_id: first.customerId,
      store_id: fixture.tenant.storeId,
      staff_id: fixture.tenant.staffId,
      reason: "customer_request",
      event_id: randomUUID(),
      now: Math.floor(Date.now() / 1_000),
    });
    assert.equal(exported?.notification_delivery_count, 1);
    assert.equal(exported?.notification_deliveries_truncated, false);
    const notificationEvidence = exported?.notification_deliveries[0];
    assert.equal(notificationEvidence?.status, "delivered");
    assert.equal(
      Array.isArray(notificationEvidence?.attempts) ? notificationEvidence.attempts.length : -1,
      1,
    );
    assert.equal(notificationEvidence?.receipt_count, 2);
    assert.doesNotMatch(
      JSON.stringify(exported?.notification_deliveries),
      /recipient_hmac|message_sha256|provider_ref_sha256|receipt_sha256|13900000001/u,
    );

    const otherTenant: TenantContext = Object.freeze({
      orgId: randomUUID(),
      storeId: randomUUID(),
      staffId: randomUUID(),
    });
    const hidden = await withPoolClient(appPool, (client) =>
      withTenantTransaction(client, otherTenant, (tx) =>
        deliveryStore.getBatch(tx, otherTenant, firstBatch.batch_id),
      ),
    );
    assert.equal(hidden, null);
  } finally {
    await appPool.end();
    await adminPool.end();
  }
});

maybe("real PG outbox moves an abandoned fifth claim to manual fallback", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  try {
    const fixture = await seedTenant(adminPool);
    const deliveryStore = createPgNotificationDeliveryStore(appPool);
    const startedAt = new Date();
    const candidate = await seedCandidate(appPool, fixture, 9, startedAt);
    const batch = await enqueue(appPool, fixture, candidate.orderId, startedAt, deliveryStore);
    const retryDelays = [60_000, 300_000, 1_800_000, 7_200_000] as const;
    let claimAt = await claimReadyAt(adminPool, batch.batch_id);
    let deliveryId = "";
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const claim = await deliveryStore.claimNext(
        fixture.tenant,
        `worker:retry-${attempt}`,
        claimAt,
      );
      assert.equal(claim?.attemptNo, attempt);
      assert.ok(claim);
      deliveryId = claim.deliveryId;
      const completedAt = new Date(claimAt.getTime() + 1_000);
      assert.equal(
        await deliveryStore.settleAttempt(fixture.tenant, {
          deliveryId: claim.deliveryId,
          leaseToken: claim.leaseToken,
          attemptNo: claim.attemptNo,
          outcome: "transient_failure",
          errorCode: "PROVIDER_BUSY",
          providerRefSha256: null,
          costCents: 0,
          startedAt: claimAt,
          completedAt,
        }),
        "retry_wait",
      );
      await makeNotificationBatchReady(adminPool, batch.batch_id);
      claimAt = new Date(completedAt.getTime() + retryDelays[attempt - 1]!);
    }
    assert.equal(await seedExpiredNotificationClaim(adminPool, batch.batch_id, 5), deliveryId);
    const privacyClient = await appPool.connect();
    const privacyLocked = deferred();
    const releasePrivacy = deferred();
    try {
      const privacyBarrier = withTenantTransaction(
        createSessionSqlClient(privacyClient),
        fixture.tenant,
        async (tx) => {
          await tx.query(
            `SELECT id FROM orders
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              FOR UPDATE`,
            [fixture.tenant.orgId, fixture.tenant.storeId, candidate.orderId],
          );
          privacyLocked.resolve();
          await releasePrivacy.promise;
        },
      );
      await privacyLocked.promise;
      const sweepAndClaim = deliveryStore.claimNext(
        fixture.tenant,
        "worker:after-crash",
        new Date(claimAt.getTime() + 30_001),
      );
      await waitForOrderLock(adminPool);
      releasePrivacy.resolve();
      const [claim] = await Promise.all([sweepAndClaim, privacyBarrier]);
      assert.equal(claim, null);
    } finally {
      releasePrivacy.resolve();
      privacyClient.release();
    }

    const row = await adminPool.query<
      Readonly<{
        status: string;
        attempt_count: number;
        last_error_code: string | null;
        recipient_hmac: string | null;
        message_sha256: string | null;
      }>
    >(
      `SELECT status, attempt_count, last_error_code, recipient_hmac, message_sha256
         FROM notification_deliveries
        WHERE batch_id = $1::uuid AND id = $2::uuid`,
      [batch.batch_id, deliveryId],
    );
    assert.equal(row.rows[0]?.status, "manual_required");
    assert.equal(row.rows[0]?.attempt_count, 5);
    assert.equal(row.rows[0]?.last_error_code, "PROVIDER_RETRY_EXHAUSTED");
    assert.equal(row.rows[0]?.recipient_hmac, null);
    assert.equal(row.rows[0]?.message_sha256, null);

    const attempts = await adminPool.query<
      Readonly<{ attempt_no: number; outcome: string; error_code: string | null }>
    >(
      `SELECT attempt_no, outcome, error_code
         FROM notification_delivery_attempts
        WHERE delivery_id = $1::uuid
        ORDER BY attempt_no`,
      [deliveryId],
    );
    assert.deepEqual(
      attempts.rows.map((attempt) => attempt.attempt_no),
      [1, 2, 3, 4, 5],
    );
    assert.equal(attempts.rows.at(-1)?.outcome, "uncertain");
    assert.equal(attempts.rows.at(-1)?.error_code, "PROVIDER_LEASE_EXPIRED");
  } finally {
    await appPool.end();
    await adminPool.end();
  }
});
