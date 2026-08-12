import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgCustomerProfileStore } from "../customer-profile/pg-store.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { hashPrintSnapshot } from "../print/snapshot.js";
import { createPgCustomerStore } from "./pg-customer-store.js";
import { anonymizePgCustomer } from "./pg-customer-privacy.js";
import { deferred, printSnapshot, waitForLock } from "./pg-customer-privacy-test-support.js";
import { CustomerErasedError } from "./types.js";
import { createPgCustomerPrivacyOperations } from "./pg-customer-privacy-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

test(
  "real PG privacy export owns print snapshots and anonymization purges only terminal copies",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const customerId = randomUUID();
    const orderId = randomUUID();
    const printJobId = randomUUID();
    const deviceId = randomUUID();
    const exportEventId = randomUUID();
    const blockedEventId = randomUUID();
    const anonymizeEventId = randomUUID();
    const pendingNonce = randomUUID();
    const cancelPendingNonce = randomUUID();
    const refundPendingNonce = randomUUID();
    const idempotencyKey = randomUUID();
    const auditId = randomUUID();
    const orderAuditId = randomUUID();
    const paymentAuditId = randomUUID();
    const sourcePaymentId = randomUUID();
    const refundPaymentId = randomUUID();
    const ticketNo = `PRIV-${orderId.slice(0, 8)}`;
    const snapshot = printSnapshot(orderId, ticketNo);
    const snapshotSha256 = hashPrintSnapshot(snapshot);
    const deviceKey = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "der",
    });
    try {
      await seedPgTestIdentityFixture(adminPool);
      const privacyAuthority = await adminPool.query<{ is_privacy_admin: boolean }>(
        `SELECT is_privacy_admin
           FROM staff_store_roles
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND staff_id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, DEMO_ADMIN_ID],
      );
      assert.equal(privacyAuthority.rows[0]?.is_privacy_admin, true);
      await adminPool.query(
        `INSERT INTO customers (id, org_id, phone, name, note, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, '13800008888', 'Privacy Customer',
                 'Privacy profile note', $3, $3)`,
        [customerId, DEMO_ORG_ID, new Date("2026-08-01T00:00:00.000Z")],
      );
      const profileStore = createPgCustomerProfileStore(appPool, { orgId: DEMO_ORG_ID });
      const profile = await profileStore.setProfile({
        customer_id: customerId,
        expected_version: 0,
        gender: "unspecified",
        preferred_contact: "wechat",
        service_note: "Private profile service note",
        waivers: {
          skip_ticket_print: true,
          skip_label_print: false,
          skip_rack_assignment: true,
        },
        addresses: [
          {
            label: "home",
            recipient: "Privacy Customer",
            contact_phone: "13800008888",
            address: "Privacy Test Road 1",
            is_default: true,
          },
        ],
        identifiers: [{ kind: "vehicle_plate", value: `PRIV-${customerId.slice(0, 8)}` }],
        reason: "customer_request",
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        at: 1_775_174_400,
      });
      assert.equal(profile?.version, 1);
      await adminPool.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
           subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents,
           freight_cents, payable_cents, paid_cents, balance_cents,
           created_at, updated_at, created_by_staff_id, business_date, customer_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'closed', '13800008888',
           'Privacy Customer', 'Call Privacy Customer on arrival',
           500, 500, 0, 0, 0, 0, 500, 500, 0,
           $5, $5, $6::uuid, '2026-08-01', $7::uuid
         )`,
        [
          orderId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          ticketNo,
          new Date("2026-08-01T00:00:00.000Z"),
          DEMO_ADMIN_ID,
          customerId,
        ],
      );
      await adminPool.query(
        `INSERT INTO payments (
           id, org_id, store_id, order_id, method, amount_cents, kind,
           ref_payment_id, staff_id, at, note, business_date
         ) VALUES
           ($1::uuid, $3::uuid, $4::uuid, $5::uuid, 'cash', 500, 'pay',
            NULL, $6::uuid, $7, NULL, '2026-08-01'),
           ($2::uuid, $3::uuid, $4::uuid, $5::uuid, 'cash', 100, 'refund',
            $1::uuid, $6::uuid, $7, 'Privacy Customer requested refund', '2026-08-01')`,
        [
          sourcePaymentId,
          refundPaymentId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          orderId,
          DEMO_ADMIN_ID,
          new Date("2026-08-01T00:00:01.000Z"),
        ],
      );
      await adminPool.query(
        `INSERT INTO command_idempotency (
           org_id, store_id, command, idempotency_key, request_hash,
           status, result_json, completed_at, privacy_subject_customer_id
         ) VALUES (
           $1::uuid, $2::uuid, 'customer.profile.set', $3::uuid, 'privacy-fixture',
           'completed', $4::jsonb, $5, $6::uuid
         )`,
        [
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          idempotencyKey,
          JSON.stringify({
            ok: true,
            data: {
              execution: "executed",
              result: { customer_id: customerId, phone: "13800008888" },
            },
          }),
          new Date("2026-08-01T00:00:01.000Z"),
          customerId,
        ],
      );
      await adminPool.query(
        `INSERT INTO ai_pending_actions (
           nonce, org_id, store_id, command, command_version, args_json,
           args_hash, creator_staff_id, idempotency_key, created_at_epoch,
           expires_at_epoch, status, effective_risk, policy_outcome,
           requires_other_approver, privacy_subject_customer_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'order.hold', '1.0.0', $4::jsonb,
           $5, $6::uuid, $7::uuid, 1775174400, 1775174700,
           'pending', 'R3', 'confirm', false, NULL
         )`,
        [
          pendingNonce,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          JSON.stringify({ customer_phone: "13800008888", customer_name: "Privacy Customer" }),
          "c".repeat(64),
          DEMO_ADMIN_ID,
          randomUUID(),
        ],
      );
      await adminPool.query(
        `INSERT INTO ai_pending_actions (
           nonce, org_id, store_id, command, command_version, args_json,
           args_hash, creator_staff_id, idempotency_key, created_at_epoch,
           expires_at_epoch, status, effective_risk, policy_outcome,
           requires_other_approver, privacy_subject_customer_id
         ) VALUES
           ($1::uuid, $3::uuid, $4::uuid, 'order.cancel', '1.0.0', $5::jsonb,
            $6, $7::uuid, $8::uuid, 1775174400, 1775174700,
            'pending', 'R3', 'confirm', false, NULL),
           ($2::uuid, $3::uuid, $4::uuid, 'payment.refund', '1.0.0', $9::jsonb,
            $10, $7::uuid, $11::uuid, 1775174400, 1775174700,
            'pending', 'R3', 'confirm', false, NULL)`,
        [
          cancelPendingNonce,
          refundPendingNonce,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          JSON.stringify({ order_id: orderId, reason: "Privacy Customer requested cancellation" }),
          "d".repeat(64),
          DEMO_ADMIN_ID,
          randomUUID(),
          JSON.stringify({
            order_id: orderId,
            ref_payment_id: sourcePaymentId,
            reason: "Privacy Customer requested refund",
          }),
          "e".repeat(64),
          randomUUID(),
        ],
      );
      await adminPool.query(
        `INSERT INTO audit_log (
           id, org_id, store_id, staff_id, via, command, dry_run,
           entity, entity_id, after_json, at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ui',
           'customer.legacy_fixture', false, 'customer', $5, $6, $7
         )`,
        [
          auditId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          DEMO_ADMIN_ID,
          customerId,
          JSON.stringify({ phone: "13800008888", note: "private audit note" }),
          new Date("2026-08-01T00:00:01.000Z"),
        ],
      );
      await adminPool.query(
        `INSERT INTO audit_log (
           id, org_id, store_id, staff_id, via, command, dry_run,
           entity, entity_id, after_json, at
         ) VALUES
           ($1::uuid, $3::uuid, $4::uuid, $5::uuid, 'ui', 'order.cancel', false,
            'order', $6, $7, $8),
           ($2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ui', 'payment.refund', false,
            'payment', $9, $10, $8)`,
        [
          orderAuditId,
          paymentAuditId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          DEMO_ADMIN_ID,
          orderId,
          JSON.stringify({
            status: "cancelled",
            reason: "Privacy Customer requested cancellation",
          }),
          new Date("2026-08-01T00:00:01.000Z"),
          refundPaymentId,
          JSON.stringify({ order_id: orderId, reason: "Privacy Customer requested refund" }),
        ],
      );
      await adminPool.query(
        `INSERT INTO edge_devices (
           org_id, store_id, device_id, public_key_spki, public_key_fingerprint,
           status, paired_by_staff_id, paired_at, last_seen_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, 'paired', $6::uuid, $7, $7
         )`,
        [
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          deviceId,
          deviceKey.toString("base64url"),
          "a".repeat(64),
          DEMO_ADMIN_ID,
          new Date("2026-08-01T00:00:00.000Z"),
        ],
      );
      await adminPool.query(
        `INSERT INTO print_jobs (
           id, org_id, store_id, order_id, ticket_no, kind, status,
           snapshot_json, snapshot_sha256, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'xp58', 'queued',
           $6::jsonb, $7, $8, $8
         )`,
        [
          printJobId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          orderId,
          ticketNo,
          JSON.stringify(snapshot),
          snapshotSha256,
          new Date("2026-08-01T00:00:01.000Z"),
        ],
      );

      const privacy = createPgCustomerPrivacyOperations(appPool, DEMO_ORG_ID);
      const blockedStatus = await privacy.privacyStatus(customerId, DEMO_STORE_ID, DEMO_ADMIN_ID);
      assert.equal(blockedStatus?.active_order_count, 1);
      assert.equal(blockedStatus?.anonymization_eligible, false);

      const exported = await privacy.exportPrivacy({
        customer_id: customerId,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        reason: "customer_request",
        event_id: exportEventId,
        now: 1_775_174_500,
      });
      const exportedOrder = exported?.orders[0];
      assert.ok(exportedOrder);
      assert.equal(exportedOrder.note, "Call Privacy Customer on arrival");
      assert.equal(exportedOrder.print_job_count, 1);
      assert.equal(exportedOrder.print_jobs_truncated, false);
      assert.equal(exported?.profile?.service_note, "Private profile service note");
      assert.equal(exported?.addresses[0]?.address, "Privacy Test Road 1");
      assert.equal(exported?.identifiers.length, 1);
      assert.ok(Array.isArray(exportedOrder.print_jobs));
      const exportedPrintJob = exportedOrder.print_jobs[0] as
        Readonly<Record<string, unknown>> | undefined;
      assert.equal(
        (exportedPrintJob?.snapshot_json as Readonly<Record<string, unknown>> | undefined)
          ?.customer_phone,
        "13800008888",
      );

      assert.equal(
        await privacy.anonymize({
          customer_id: customerId,
          store_id: DEMO_STORE_ID,
          staff_id: DEMO_ADMIN_ID,
          reason: "customer_request",
          event_id: blockedEventId,
          now: 1_775_174_501,
        }),
        null,
      );
      await adminPool.query(
        `UPDATE print_jobs
            SET status = 'printing', dispatch_device_id = $2::uuid,
                dispatch_staff_id = $3::uuid, ticket_nonce = $4::uuid,
                capability_json = '{}'::jsonb, dispatch_issued_at = $5,
                dispatch_expires_at = $6, updated_at = $5
          WHERE id = $1::uuid`,
        [
          printJobId,
          deviceId,
          DEMO_ADMIN_ID,
          randomUUID(),
          new Date("2026-08-01T00:00:02.000Z"),
          new Date("2026-08-01T00:01:02.000Z"),
        ],
      );
      assert.equal(
        await privacy.anonymize({
          customer_id: customerId,
          store_id: DEMO_STORE_ID,
          staff_id: DEMO_ADMIN_ID,
          reason: "customer_request",
          event_id: blockedEventId,
          now: 1_775_174_502,
        }),
        null,
      );

      await adminPool.query(
        `UPDATE print_jobs
            SET status = 'done', receipt_seq = 1, receipt_result = 'succeeded',
                cups_job_id = 'xp58-1', receipt_at = $2,
                receipt_json = '{}'::jsonb, receipt_envelope_sha256 = $3,
                settled_at = $2, updated_at = $2, completed_at = $2
          WHERE id = $1::uuid`,
        [printJobId, new Date("2026-08-01T00:00:03.000Z"), "b".repeat(64)],
      );
      const eligibleStatus = await privacy.privacyStatus(customerId, DEMO_STORE_ID, DEMO_ADMIN_ID);
      assert.equal(eligibleStatus?.active_order_count, 0);
      assert.equal(eligibleStatus?.anonymization_eligible, true);

      await assert.rejects(
        () =>
          privacy.anonymize({
            customer_id: customerId,
            store_id: DEMO_STORE_ID,
            staff_id: DEMO_ADMIN_ID,
            reason: "customer_request",
            event_id: exportEventId,
            now: 1_775_174_503,
          }),
        /duplicate key/iu,
      );
      const rolledBack = await adminPool.query<{
        customer_name: string | null;
        order_customer_name: string | null;
        snapshot_json: unknown;
        pending_count: number;
        audit_after_json: string;
        tombstone_count: number;
      }>(
        `SELECT
           (SELECT name FROM customers WHERE id = $1::uuid) AS customer_name,
           (SELECT customer_name FROM orders WHERE id = $2::uuid) AS order_customer_name,
           (SELECT snapshot_json FROM print_jobs WHERE id = $3::uuid) AS snapshot_json,
           (SELECT count(*)::integer FROM ai_pending_actions
             WHERE nonce = ANY($4::uuid[])) AS pending_count,
           (SELECT after_json FROM audit_log WHERE id = $5::uuid) AS audit_after_json,
           (SELECT count(*)::integer FROM customer_erasure_tombstones
             WHERE org_id = $6::uuid AND customer_id = $1::uuid) AS tombstone_count`,
        [
          customerId,
          orderId,
          printJobId,
          [cancelPendingNonce, refundPendingNonce],
          orderAuditId,
          DEMO_ORG_ID,
        ],
      );
      assert.equal(rolledBack.rows[0]?.customer_name, "Privacy Customer");
      assert.equal(rolledBack.rows[0]?.order_customer_name, "Privacy Customer");
      assert.notEqual(rolledBack.rows[0]?.snapshot_json, null);
      assert.equal(rolledBack.rows[0]?.pending_count, 2);
      assert.match(rolledBack.rows[0]?.audit_after_json ?? "", /Privacy Customer/u);
      assert.equal(rolledBack.rows[0]?.tombstone_count, 0);

      const anonymized = await privacy.anonymize({
        customer_id: customerId,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        reason: "customer_request",
        event_id: anonymizeEventId,
        now: 1_775_174_503,
      });
      assert.deepEqual(anonymized, { customer_id: customerId, affected_order_count: 1 });
      const retained = await adminPool.query<{
        customer_phone: string | null;
        customer_name: string | null;
        note: string | null;
        snapshot_json: unknown;
        snapshot_sha256: string;
        snapshot_purged_at: Date | null;
        capability_json: unknown;
        receipt_json: unknown;
      }>(
        `SELECT order_row.customer_phone, order_row.customer_name, order_row.note,
                print_job.snapshot_json, print_job.snapshot_sha256,
                print_job.snapshot_purged_at, print_job.capability_json, print_job.receipt_json
           FROM orders order_row
           JOIN print_jobs print_job
             ON print_job.org_id = order_row.org_id
            AND print_job.store_id = order_row.store_id
            AND print_job.order_id = order_row.id
          WHERE order_row.id = $1::uuid`,
        [orderId],
      );
      assert.deepEqual(retained.rows[0], {
        customer_phone: null,
        customer_name: null,
        note: null,
        snapshot_json: null,
        snapshot_sha256: snapshotSha256,
        snapshot_purged_at: new Date(1_775_174_503_000),
        capability_json: {},
        receipt_json: {},
      });
      const purgedCopies = await adminPool.query<{
        address_label: string | null;
        address_body: string | null;
        raw_value: string | null;
        normalized_value: string | null;
        service_note: string | null;
        pending_count: number;
        related_pending_count: number;
        result_json: unknown;
        idempotency_purged_at: Date | null;
        audit_after_json: string;
        order_audit_after_json: string;
        payment_audit_after_json: string;
        payment_note: string | null;
        tombstone_count: number;
      }>(
        `SELECT
           (SELECT label FROM customer_addresses
             WHERE org_id = $1::uuid AND customer_id = $2::uuid LIMIT 1) AS address_label,
           (SELECT address_body FROM customer_addresses
             WHERE org_id = $1::uuid AND customer_id = $2::uuid LIMIT 1) AS address_body,
           (SELECT raw_value FROM customer_identifiers
             WHERE org_id = $1::uuid AND customer_id = $2::uuid LIMIT 1) AS raw_value,
           (SELECT normalized_value FROM customer_identifiers
             WHERE org_id = $1::uuid AND customer_id = $2::uuid LIMIT 1) AS normalized_value,
           (SELECT service_note FROM customer_profiles
             WHERE org_id = $1::uuid AND customer_id = $2::uuid) AS service_note,
           (SELECT count(*)::integer FROM ai_pending_actions WHERE nonce = $3::uuid) AS pending_count,
           (SELECT count(*)::integer FROM ai_pending_actions
             WHERE nonce = ANY($6::uuid[])) AS related_pending_count,
           (SELECT result_json FROM command_idempotency
             WHERE org_id = $1::uuid AND idempotency_key = $4::uuid) AS result_json,
           (SELECT pii_purged_at FROM command_idempotency
             WHERE org_id = $1::uuid AND idempotency_key = $4::uuid) AS idempotency_purged_at,
           (SELECT after_json FROM audit_log WHERE id = $5::uuid) AS audit_after_json,
           (SELECT after_json FROM audit_log WHERE id = $7::uuid) AS order_audit_after_json,
           (SELECT after_json FROM audit_log WHERE id = $8::uuid) AS payment_audit_after_json,
           (SELECT note FROM payments WHERE id = $9::uuid) AS payment_note,
           (SELECT count(*)::integer FROM customer_erasure_tombstones
             WHERE org_id = $1::uuid AND customer_id = $2::uuid) AS tombstone_count`,
        [
          DEMO_ORG_ID,
          customerId,
          pendingNonce,
          idempotencyKey,
          auditId,
          [cancelPendingNonce, refundPendingNonce],
          orderAuditId,
          paymentAuditId,
          refundPaymentId,
        ],
      );
      assert.deepEqual(purgedCopies.rows[0], {
        address_label: null,
        address_body: null,
        raw_value: null,
        normalized_value: null,
        service_note: null,
        pending_count: 0,
        related_pending_count: 0,
        result_json: {
          ok: false,
          error: {
            code: "CUSTOMER_ERASED",
            message: "Customer data was erased and cannot be recreated",
          },
        },
        idempotency_purged_at: new Date(1_775_174_503_000),
        audit_after_json: '{"privacy_redacted":true}',
        order_audit_after_json: '{"privacy_redacted":true}',
        payment_audit_after_json: '{"privacy_redacted":true}',
        payment_note: null,
        tombstone_count: 1,
      });
      await assert.rejects(
        () =>
          createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID }).upsert({
            phone: "13800008888",
            name: "Revived offline value",
            now: 1_775_174_504,
          }),
        CustomerErasedError,
      );
      await adminPool.query("UPDATE print_jobs SET snapshot_json = $2::jsonb WHERE id = $1::uuid", [
        printJobId,
        JSON.stringify(snapshot),
      ]);
      const settledPrint = await adminPool.query<
        Readonly<{ snapshot_json: unknown; snapshot_purged_at: Date | null }>
      >(
        `SELECT snapshot_json, snapshot_purged_at
           FROM print_jobs
          WHERE id = $1::uuid`,
        [printJobId],
      );
      assert.equal(settledPrint.rows[0]?.snapshot_json, null);
      assert.notEqual(settledPrint.rows[0]?.snapshot_purged_at, null);
    } finally {
      await adminPool.query(
        "DELETE FROM command_idempotency WHERE org_id = $1::uuid AND idempotency_key = $2::uuid",
        [DEMO_ORG_ID, idempotencyKey],
      );
      await adminPool.query("DELETE FROM ai_pending_actions WHERE nonce = $1::uuid", [
        pendingNonce,
      ]);
      await adminPool.query("DELETE FROM ai_pending_actions WHERE nonce = ANY($1::uuid[])", [
        [cancelPendingNonce, refundPendingNonce],
      ]);
      await adminPool.query("DELETE FROM audit_log WHERE id = $1::uuid", [auditId]);
      await adminPool.query("DELETE FROM audit_log WHERE id = ANY($1::uuid[])", [
        [orderAuditId, paymentAuditId],
      ]);
      await adminPool.query("DELETE FROM customer_privacy_events WHERE customer_id = $1::uuid", [
        customerId,
      ]);
      await adminPool.query("DELETE FROM print_jobs WHERE id = $1::uuid", [printJobId]);
      await adminPool.query("DELETE FROM payments WHERE id = ANY($1::uuid[])", [
        [sourcePaymentId, refundPaymentId],
      ]);
      await adminPool.query("DELETE FROM orders WHERE id = $1::uuid", [orderId]);
      await adminPool.query(
        "DELETE FROM customer_erasure_tombstones WHERE org_id = $1::uuid AND customer_id = $2::uuid",
        [DEMO_ORG_ID, customerId],
      );
      await adminPool.query(
        "DELETE FROM customer_addresses WHERE org_id = $1::uuid AND customer_id = $2::uuid",
        [DEMO_ORG_ID, customerId],
      );
      await adminPool.query(
        "DELETE FROM customer_identifiers WHERE org_id = $1::uuid AND customer_id = $2::uuid",
        [DEMO_ORG_ID, customerId],
      );
      await adminPool.query(
        "DELETE FROM customer_profiles WHERE org_id = $1::uuid AND customer_id = $2::uuid",
        [DEMO_ORG_ID, customerId],
      );
      await adminPool.query("DELETE FROM customers WHERE id = $1::uuid", [customerId]);
      await adminPool.query(
        `DELETE FROM edge_devices
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND device_id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, deviceId],
      );
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);

test(
  "real PG privacy export includes every canonical-group profile",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const eventId = randomUUID();
    try {
      await seedPgTestIdentityFixture(adminPool);
      await adminPool.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES
           ($1::uuid, $3::uuid, $4, 'Profile Source', now(), now()),
           ($2::uuid, $3::uuid, $5, 'Profile Target', now(), now())`,
        [
          sourceId,
          targetId,
          DEMO_ORG_ID,
          `privacy-source-${sourceId}`,
          `privacy-target-${targetId}`,
        ],
      );
      const profiles = createPgCustomerProfileStore(appPool, { orgId: DEMO_ORG_ID });
      const profileInput = (customerId: string, serviceNote: string, at: number) => ({
        customer_id: customerId,
        expected_version: 0,
        gender: "unspecified" as const,
        preferred_contact: "none" as const,
        service_note: serviceNote,
        waivers: {
          skip_ticket_print: false,
          skip_label_print: false,
          skip_rack_assignment: false,
        },
        addresses: [],
        identifiers: [],
        reason: "Synthetic merged profile export",
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        at,
      });
      assert.ok(await profiles.setProfile(profileInput(targetId, "Target private note", 100)));
      assert.ok(await profiles.setProfile(profileInput(sourceId, "Source private note", 200)));
      assert.ok(
        await createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID }).merge({
          source_customer_id: sourceId,
          target_customer_id: targetId,
          store_id: DEMO_STORE_ID,
          staff_id: DEMO_ADMIN_ID,
          now: 300,
        }),
      );

      const exported = await createPgCustomerPrivacyOperations(appPool, DEMO_ORG_ID).exportPrivacy({
        customer_id: sourceId,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        reason: "customer_request",
        event_id: eventId,
        now: 400,
      });
      assert.equal(exported?.format_version, 2);
      assert.equal(exported?.canonical_customer_count, 2);
      assert.equal(exported?.profile_count, 2);
      assert.equal(exported?.profiles_truncated, false);
      assert.equal(exported?.profile?.customer_id, targetId);
      assert.deepEqual(
        exported?.profiles.map((profile) => profile.service_note),
        ["Target private note", "Source private note"],
      );
    } finally {
      await adminPool.query("DELETE FROM customer_privacy_events WHERE id = $1::uuid", [eventId]);
      await adminPool.query(
        "DELETE FROM customer_profiles WHERE org_id = $1::uuid AND customer_id = ANY($2::uuid[])",
        [DEMO_ORG_ID, [sourceId, targetId]],
      );
      await adminPool.query("DELETE FROM customers WHERE id = $1::uuid", [sourceId]);
      await adminPool.query("DELETE FROM customers WHERE id = $1::uuid", [targetId]);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);

test(
  "real PG erasure serializes an already-started old-phone replay before tombstone check",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app, max: 2 });
    const customerId = randomUUID();
    const eventId = randomUUID();
    const phone = "13800008889";
    const privacyClient = await appPool.connect();
    const replayClient = await appPool.connect();
    const locksHeld = deferred();
    const allowAnonymize = deferred();
    try {
      await seedPgTestIdentityFixture(adminPool);
      await adminPool.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, 'Concurrent Privacy Customer', now(), now())`,
        [customerId, DEMO_ORG_ID, phone],
      );
      const replayPid = await replayClient.query<Readonly<{ pid: number }>>(
        "SELECT pg_backend_pid() AS pid",
      );
      const anonymizing = withTenantTransaction(
        privacyClient as unknown as SqlClient,
        TENANT,
        async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 42))", [DEMO_ORG_ID]);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `customer-phone:${DEMO_ORG_ID}`,
          ]);
          locksHeld.resolve();
          await allowAnonymize.promise;
          return anonymizePgCustomer(tx, {
            customer_id: customerId,
            store_id: DEMO_STORE_ID,
            staff_id: DEMO_ADMIN_ID,
            reason: "customer_request",
            event_id: eventId,
            now: 1_775_174_600,
          });
        },
      );
      await locksHeld.promise;
      const replaying = withTenantTransaction(replayClient as unknown as SqlClient, TENANT, () =>
        createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID }).upsert({
          phone,
          name: "Old queued customer value",
          now: 1_775_174_601,
        }),
      );
      await waitForLock(adminPool, replayPid.rows[0]!.pid);
      allowAnonymize.resolve();

      const [anonymized, replayed] = await Promise.allSettled([anonymizing, replaying]);
      assert.equal(anonymized.status, "fulfilled");
      if (anonymized.status === "fulfilled") {
        assert.deepEqual(anonymized.value, { customer_id: customerId, affected_order_count: 0 });
      }
      assert.equal(replayed.status, "rejected");
      if (replayed.status === "rejected") assert.ok(replayed.reason instanceof CustomerErasedError);
      const livePhone = await adminPool.query<Readonly<{ count: number }>>(
        "SELECT count(*)::integer AS count FROM customers WHERE org_id = $1::uuid AND phone = $2",
        [DEMO_ORG_ID, phone],
      );
      assert.equal(livePhone.rows[0]?.count, 0);
    } finally {
      allowAnonymize.resolve();
      privacyClient.release();
      replayClient.release();
      await adminPool.query("DELETE FROM customer_privacy_events WHERE customer_id = $1::uuid", [
        customerId,
      ]);
      await adminPool.query(
        "DELETE FROM customer_erasure_tombstones WHERE org_id = $1::uuid AND customer_id = $2::uuid",
        [DEMO_ORG_ID, customerId],
      );
      await adminPool.query("DELETE FROM customers WHERE id = $1::uuid", [customerId]);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);
