import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { hashCanonical } from "../pending-actions/canonical.js";
import { createPgCustomerStore } from "./pg-customer-store.js";
import { createPgCustomerPrivacyOperations } from "./pg-customer-privacy-store.js";
import { CustomerErasedError } from "./types.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const PII = "Synthetic Privacy Name";
const OLD_PHONE = "13800008886";
const CURRENT_PHONE = "13800008887";
const AT = new Date("2026-08-02T00:00:00.000Z");
const EXPECTED_SOURCES = Object.freeze([
  "audit_log",
  "coupon_grant",
  "coupon_redemption_reversal",
  "garment",
  "garment_incident",
  "garment_status",
  "member_account",
  "member_ledger",
  "member_membership",
  "order_line_garment_details",
  "payment",
  "points_ledger",
  "punch_card",
  "punch_card_ledger",
]);

function ids() {
  return Object.freeze({
    customer: randomUUID(),
    order: randomUUID(),
    line: randomUUID(),
    garment: randomUUID(),
    payment: randomUUID(),
    status: randomUUID(),
    incident: randomUUID(),
    photo: randomUUID(),
    account: randomUUID(),
    memberLedger: randomUUID(),
    membershipEvent: randomUUID(),
    points: randomUUID(),
    punchDefinition: randomUUID(),
    punchCard: randomUUID(),
    punchLedger: randomUUID(),
    couponDefinition: randomUUID(),
    couponGrant: randomUUID(),
    couponRedemption: randomUUID(),
    couponReversal: randomUUID(),
    idempotencyKey: randomUUID(),
    edgeDevice: randomUUID(),
    edgeGrant: randomUUID(),
    edgeReplay: randomUUID(),
    edgeQueue: randomUUID(),
    audit: randomUUID(),
    pending: randomUUID(),
    pendingKey: randomUUID(),
    revivedPending: randomUUID(),
    revivedPendingKey: randomUUID(),
    exportEvent: randomUUID(),
    anonymizeEvent: randomUUID(),
    postPayment: randomUUID(),
    postMemberLedger: randomUUID(),
    postPoints: randomUUID(),
    postIncident: randomUUID(),
    postPhoto: randomUUID(),
    postPrint: randomUUID(),
  });
}

test(
  "real PG exports, erases and permanently guards every subject narrative",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const row = ids();
    const admin = createPgPool({ connectionString: urls.admin });
    const app = createPgPool({ connectionString: urls.app });
    try {
      await seedPgTestIdentityFixture(admin);
      await admin.query(
        `INSERT INTO customers (id, org_id, phone, name, note, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $4, $5, $5)`,
        [row.customer, DEMO_ORG_ID, OLD_PHONE, PII, AT],
      );
      const customerStore = createPgCustomerStore(app, { orgId: DEMO_ORG_ID });
      assert.equal(
        (
          await customerStore.update({
            customer_id: row.customer,
            expected_version: 1,
            phone: CURRENT_PHONE,
            now: Math.floor(AT.getTime() / 1000) + 1,
          })
        )?.phone,
        CURRENT_PHONE,
      );
      const legacyPendingArgs = Object.freeze({
        customer_phone: OLD_PHONE,
        customer_name: PII,
      });
      await admin.query(
        `INSERT INTO ai_pending_actions (
           nonce, org_id, store_id, command, command_version, args_json,
           authority_present, args_hash, entity_versions_json, creator_staff_id,
           idempotency_key, created_at_epoch, expires_at_epoch, status,
           effective_risk, policy_outcome, requires_other_approver,
           consumed_by_staff_id, consumed_at_epoch
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'order.hold', '1.0.0', $4::jsonb,
           false, $5, '[]'::jsonb, $6::uuid,
           $7::uuid, $8::bigint, $9::bigint, 'pending',
           'R3', 'confirm', false, NULL, NULL
         )`,
        [
          row.pending,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          JSON.stringify(legacyPendingArgs),
          hashCanonical(legacyPendingArgs),
          DEMO_ADMIN_ID,
          row.pendingKey,
          Math.floor(AT.getTime() / 1000),
          Math.floor(AT.getTime() / 1000) + 300,
        ],
      );
      await admin.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
           subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents,
           freight_cents, payable_cents, paid_cents, balance_cents, created_at, updated_at,
           created_by_staff_id, business_date, customer_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'closed', $5, $6, $6,
           500, 500, 0, 0, 0, 0, 500, 500, 0, $7, $7, $8::uuid, '2026-08-02', $9::uuid
         )`,
        [
          row.order,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          `PII-${row.order.slice(0, 8)}`,
          CURRENT_PHONE,
          PII,
          AT,
          DEMO_ADMIN_ID,
          row.customer,
        ],
      );
      await admin.query(
        `INSERT INTO order_lines (
           id, org_id, store_id, order_id, line_index, service_code, category_code,
           unit_price_cents, qty, line_total_cents, garment_details_json
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'wash', 'shirt', 500, 1, 500,
           $5::jsonb)`,
        [
          row.line,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.order,
          JSON.stringify([
            { note: PII, defects: [PII], accessories: [PII], addons: [], color: null, brand: null },
          ]),
        ],
      );
      await admin.query(
        `INSERT INTO garments (
           id, org_id, store_id, order_id, order_line_id, seq, barcode, service_code,
           category_code, unit_price_cents, status, defects, accessories, note
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, $6,
           'wash', 'shirt', 500, 'ready', $7::jsonb, $7::jsonb, $8
         )`,
        [
          row.garment,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.order,
          row.line,
          `PII-${row.garment.slice(0, 12)}`,
          JSON.stringify([PII]),
          PII,
        ],
      );
      await admin.query(
        `INSERT INTO payments (
           id, org_id, store_id, order_id, method, amount_cents, kind,
           staff_id, at, note, business_date
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 500, 'pay',
                   $5::uuid, $6, $7, '2026-08-02')`,
        [row.payment, DEMO_ORG_ID, DEMO_STORE_ID, row.order, DEMO_ADMIN_ID, AT, PII],
      );
      await admin.query(
        `INSERT INTO garment_status_log (
           id, org_id, store_id, order_id, garment_id, from_status, to_status, reason, staff_id, at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'washing', 'ready', $6, $7::uuid, $8)`,
        [row.status, DEMO_ORG_ID, DEMO_STORE_ID, row.order, row.garment, PII, DEMO_ADMIN_ID, AT],
      );
      await admin.query(
        `INSERT INTO garment_incidents (
           id, org_id, store_id, order_id, garment_id, kind, note,
           compensation_cents, staff_id, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'other', $6, 0, $7::uuid, $8)`,
        [row.incident, DEMO_ORG_ID, DEMO_STORE_ID, row.order, row.garment, PII, DEMO_ADMIN_ID, AT],
      );
      await admin.query(
        `INSERT INTO garment_photos (
           id, org_id, store_id, garment_id, order_id, kind, storage_key,
           byte_size, taken_at, created_by_staff_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'other', $6, 1, $7, $8::uuid)`,
        [
          row.photo,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.garment,
          row.order,
          `synthetic/${row.photo}.jpg`,
          AT,
          DEMO_ADMIN_ID,
        ],
      );
      await admin.query(
        `INSERT INTO member_accounts (
           id, org_id, customer_id, status, opened_at, opened_store_id,
           status_changed_at, status_reason, status_changed_by_staff_id, status_changed_store_id
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'active', $4, $5::uuid,
                   $4, $6, $7::uuid, $5::uuid)`,
        [row.account, DEMO_ORG_ID, row.customer, AT, DEMO_STORE_ID, PII, DEMO_ADMIN_ID],
      );
      await admin.query(
        `INSERT INTO member_ledger (
           id, org_id, store_id, account_id, kind, principal_delta_cents,
           bonus_delta_cents, staff_id, at, business_date, note
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup', 100, 0,
                   $5::uuid, $6, '2026-08-02', $7)`,
        [row.memberLedger, DEMO_ORG_ID, DEMO_STORE_ID, row.account, DEMO_ADMIN_ID, AT, PII],
      );
      await admin.query(
        `INSERT INTO member_memberships (
           org_id, account_id, version, updated_at, updated_store_id,
           updated_by_staff_id, reason
         ) VALUES ($1::uuid, $2::uuid, 1, $3, $4::uuid, $5::uuid, $6)`,
        [DEMO_ORG_ID, row.account, AT, DEMO_STORE_ID, DEMO_ADMIN_ID, PII],
      );
      await admin.query(
        `INSERT INTO points_ledger (
           id, org_id, store_id, account_id, kind, points_delta, staff_id, at, note
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'redeem', -1,
                   $5::uuid, $6, $7)`,
        [row.points, DEMO_ORG_ID, DEMO_STORE_ID, row.account, DEMO_ADMIN_ID, AT, PII],
      );
      await admin.query(
        `INSERT INTO member_punch_types (
           id, org_id, code, name, total_uses, valid_days, status, updated_at, updated_by_staff_id
         ) VALUES ($1::uuid, $2::uuid, $3, 'Synthetic', 10, 30, 'active', $4, $5::uuid)`,
        [
          row.punchDefinition,
          DEMO_ORG_ID,
          `p${row.punchDefinition.replaceAll("-", "").slice(0, 12)}`,
          AT,
          DEMO_ADMIN_ID,
        ],
      );
      await admin.query(
        `INSERT INTO coupons (
           id, org_id, code, name, discount_cents, min_order_cents, valid_days,
           status, updated_at, updated_by_staff_id
         ) VALUES ($1::uuid, $2::uuid, $3, 'Synthetic', 100, 0, 30, 'active', $4, $5::uuid)`,
        [
          row.couponDefinition,
          DEMO_ORG_ID,
          `c${row.couponDefinition.replaceAll("-", "").slice(0, 12)}`,
          AT,
          DEMO_ADMIN_ID,
        ],
      );
      await admin.query(
        `INSERT INTO punch_cards (
           id, org_id, account_id, definition_id, code, name, total_uses,
           issued_on, expires_on, issued_at, issued_store_id, issued_by_staff_id, reason
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'punch', 'Synthetic', 10,
                   '2026-08-02', '2026-09-01', $5, $6::uuid, $7::uuid, $8)`,
        [
          row.punchCard,
          DEMO_ORG_ID,
          row.account,
          row.punchDefinition,
          AT,
          DEMO_STORE_ID,
          DEMO_ADMIN_ID,
          PII,
        ],
      );
      await admin.query(
        `INSERT INTO punch_card_ledger (
           id, org_id, store_id, card_id, account_id, uses, staff_id, at, reason
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1,
                   $6::uuid, $7, $8)`,
        [
          row.punchLedger,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.punchCard,
          row.account,
          DEMO_ADMIN_ID,
          AT,
          PII,
        ],
      );
      await admin.query(
        `INSERT INTO coupon_grants (
           id, org_id, account_id, definition_id, code, name, discount_cents,
           min_order_cents, granted_on, expires_on, granted_at, granted_store_id,
           granted_by_staff_id, reason
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'coupon', 'Synthetic', 100,
                   0, '2026-08-02', '2026-09-01', $5, $6::uuid, $7::uuid, $8)`,
        [
          row.couponGrant,
          DEMO_ORG_ID,
          row.account,
          row.couponDefinition,
          AT,
          DEMO_STORE_ID,
          DEMO_ADMIN_ID,
          PII,
        ],
      );
      await admin.query(
        `INSERT INTO coupon_redemptions (
           id, org_id, store_id, grant_id, account_id, order_id,
           discount_cents, staff_id, at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                   100, $7::uuid, $8)`,
        [
          row.couponRedemption,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.couponGrant,
          row.account,
          row.order,
          DEMO_ADMIN_ID,
          AT,
        ],
      );
      await admin.query(
        `INSERT INTO coupon_redemption_reversals (
           id, org_id, store_id, redemption_id, grant_id, order_id, staff_id, at, reason
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
                   $7::uuid, $8, $9)`,
        [
          row.couponReversal,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.couponRedemption,
          row.couponGrant,
          row.order,
          DEMO_ADMIN_ID,
          AT,
          PII,
        ],
      );
      const cachedResult = JSON.stringify({
        ok: true,
        data: {
          result: { benefits: { customer_id: row.customer, points: { recent: [{ note: PII }] } } },
        },
      });
      await admin.query(
        `INSERT INTO command_idempotency (
           org_id, store_id, command, idempotency_key, request_hash,
           status, result_json, completed_at
         ) VALUES ($1::uuid, $2::uuid, 'member.points.earn', $3::uuid, $4,
                   'completed', $5::jsonb, $6)`,
        [DEMO_ORG_ID, DEMO_STORE_ID, row.idempotencyKey, "a".repeat(64), cachedResult, AT],
      );
      await admin.query(
        `INSERT INTO edge_devices (
           org_id, store_id, device_id, public_key_spki, public_key_fingerprint,
           paired_by_staff_id, paired_at, last_seen_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $7)`,
        [
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.edgeDevice,
          "A".repeat(44),
          "b".repeat(64),
          DEMO_ADMIN_ID,
          AT,
        ],
      );
      await admin.query(
        `INSERT INTO offline_grants (
           id, org_id, store_id, staff_id, device_id, request_nonce, permission_version,
           allowed_commands, protocol_version, signature, issued_at, not_after
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1,
                   '["member.points.earn"]'::jsonb, '1.0.0', $7, $8, $9)`,
        [
          row.edgeGrant,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          DEMO_ADMIN_ID,
          row.edgeDevice,
          randomUUID(),
          "C".repeat(86),
          AT,
          new Date(AT.getTime() + 60_000),
        ],
      );
      await admin.query(
        `INSERT INTO edge_replay_records (
           id, org_id, store_id, reported_queue_id, grant_id,
           original_staff_id, replayed_by_staff_id, device_id,
           envelope_sha256, command, idempotency_key, decision, reason,
           result_json, recorded_at, authorization_kind, reported_per_grant_seq
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   $6::uuid, $6::uuid, $7::uuid, $8, 'member.points.earn', $9::uuid,
                   'rejected', 'synthetic', $10::jsonb, $11, 'grant', 1)`,
        [
          row.edgeReplay,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.edgeQueue,
          row.edgeGrant,
          DEMO_ADMIN_ID,
          row.edgeDevice,
          "d".repeat(64),
          row.idempotencyKey,
          cachedResult,
          AT,
        ],
      );
      await admin.query(
        `INSERT INTO audit_log (
           id, org_id, store_id, staff_id, via, command, dry_run,
           entity, entity_id, after_json, at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'web',
                   'customer.profile.set', false, 'customer_profile', $5, $6, $7)`,
        [
          row.audit,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          DEMO_ADMIN_ID,
          row.customer,
          JSON.stringify({ reason: PII }),
          AT,
        ],
      );

      const privacy = createPgCustomerPrivacyOperations(app, DEMO_ORG_ID);
      const exported = await privacy.exportPrivacy({
        customer_id: row.customer,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        reason: "customer_request",
        event_id: row.exportEvent,
        now: Math.floor(AT.getTime() / 1000) + 1,
      });
      assert.ok(exported);
      assert.deepEqual(
        exported.related_narratives.map((entry) => entry.source).sort(),
        EXPECTED_SOURCES,
      );
      assert.equal(exported.related_narrative_count, EXPECTED_SOURCES.length);
      assert.equal(exported.related_narratives_truncated, false);
      assert.equal(exported.retained_garment_photo_count, 1);
      for (const narrative of exported.related_narratives) {
        assert.match(JSON.stringify(narrative.payload), new RegExp(PII, "u"));
      }

      const anonymized = await privacy.anonymize({
        customer_id: row.customer,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        reason: "customer_request",
        event_id: row.anonymizeEvent,
        now: Math.floor(AT.getTime() / 1000) + 2,
      });
      assert.deepEqual(anonymized, { customer_id: row.customer, affected_order_count: 1 });
      await assert.rejects(
        () => customerStore.upsert({ phone: OLD_PHONE, name: PII }),
        CustomerErasedError,
      );
      await assert.rejects(
        () => customerStore.upsert({ phone: CURRENT_PHONE, name: PII }),
        CustomerErasedError,
      );
      await assert.rejects(
        () =>
          admin.query(
            `INSERT INTO ai_pending_actions (
               nonce, org_id, store_id, command, command_version, args_json,
               authority_present, args_hash, entity_versions_json, creator_staff_id,
               idempotency_key, created_at_epoch, expires_at_epoch, status,
               effective_risk, policy_outcome, requires_other_approver,
               consumed_by_staff_id, consumed_at_epoch
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'order.hold', '1.0.0', $4::jsonb,
               false, $5, '[]'::jsonb, $6::uuid,
               $7::uuid, $8::bigint, $9::bigint, 'pending',
               'R3', 'confirm', false, NULL, NULL
             )`,
            [
              row.revivedPending,
              DEMO_ORG_ID,
              DEMO_STORE_ID,
              JSON.stringify(legacyPendingArgs),
              hashCanonical(legacyPendingArgs),
              DEMO_ADMIN_ID,
              row.revivedPendingKey,
              Math.floor(AT.getTime() / 1000) + 3,
              Math.floor(AT.getTime() / 1000) + 303,
            ],
          ),
        /CUSTOMER_ERASED/u,
      );
      const cleared = await admin.query<
        Readonly<{
          payment_note: string | null;
          line_details: unknown;
          garment_note: string | null;
          garment_defects: unknown;
          status_reason: string | null;
          incident_note: string;
          account_reason: string | null;
          member_note: string | null;
          membership_reason: string;
          points_note: string | null;
          punch_reason: string;
          punch_ledger_reason: string;
          coupon_reason: string;
          reversal_reason: string;
          idempotency_code: string;
          replay_code: string;
          audit_after_json: string;
          pending_count: number;
        }>
      >(
        `SELECT
           (SELECT note FROM payments WHERE id = $1::uuid) AS payment_note,
           (SELECT garment_details_json FROM order_lines WHERE id = $2::uuid) AS line_details,
           (SELECT note FROM garments WHERE id = $3::uuid) AS garment_note,
           (SELECT defects FROM garments WHERE id = $3::uuid) AS garment_defects,
           (SELECT reason FROM garment_status_log WHERE id = $4::uuid) AS status_reason,
           (SELECT note FROM garment_incidents WHERE id = $5::uuid) AS incident_note,
           (SELECT status_reason FROM member_accounts WHERE id = $6::uuid) AS account_reason,
           (SELECT note FROM member_ledger WHERE id = $7::uuid) AS member_note,
           (SELECT reason FROM member_memberships WHERE account_id = $6::uuid) AS membership_reason,
           (SELECT note FROM points_ledger WHERE id = $8::uuid) AS points_note,
           (SELECT reason FROM punch_cards WHERE id = $9::uuid) AS punch_reason,
           (SELECT reason FROM punch_card_ledger WHERE id = $10::uuid) AS punch_ledger_reason,
           (SELECT reason FROM coupon_grants WHERE id = $11::uuid) AS coupon_reason,
           (SELECT reason FROM coupon_redemption_reversals WHERE id = $12::uuid) AS reversal_reason,
           (SELECT result_json #>> '{error,code}' FROM command_idempotency
             WHERE idempotency_key = $13::uuid) AS idempotency_code,
           (SELECT result_json #>> '{error,code}' FROM edge_replay_records
             WHERE id = $14::uuid) AS replay_code,
           (SELECT after_json FROM audit_log WHERE id = $15::uuid) AS audit_after_json,
           (SELECT count(*)::integer FROM ai_pending_actions
             WHERE nonce = $16::uuid) AS pending_count`,
        [
          row.payment,
          row.line,
          row.garment,
          row.status,
          row.incident,
          row.account,
          row.memberLedger,
          row.points,
          row.punchCard,
          row.punchLedger,
          row.couponGrant,
          row.couponReversal,
          row.idempotencyKey,
          row.edgeReplay,
          row.audit,
          row.pending,
        ],
      );
      assert.deepEqual(cleared.rows[0], {
        payment_note: null,
        line_details: [
          { note: null, brand: null, color: null, addons: [], defects: [], accessories: [] },
        ],
        garment_note: null,
        garment_defects: [],
        status_reason: null,
        incident_note: "privacy_redacted",
        account_reason: "privacy_redacted",
        member_note: null,
        membership_reason: "privacy_redacted",
        points_note: "privacy_redacted",
        punch_reason: "privacy_redacted",
        punch_ledger_reason: "privacy_redacted",
        coupon_reason: "privacy_redacted",
        reversal_reason: "privacy_redacted",
        idempotency_code: "CUSTOMER_ERASED",
        replay_code: "CUSTOMER_ERASED",
        audit_after_json: '{"privacy_redacted":true}',
        pending_count: 0,
      });

      await admin.query(
        `INSERT INTO payments (
           id, org_id, store_id, order_id, method, amount_cents, kind, ref_payment_id,
           staff_id, at, note, business_date
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'cash', 1, 'refund',
                   $5::uuid, $6::uuid, $7, $8, '2026-08-02')`,
        [
          row.postPayment,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.order,
          row.payment,
          DEMO_ADMIN_ID,
          AT,
          PII,
        ],
      );
      await admin.query(
        `INSERT INTO member_ledger (
           id, org_id, store_id, account_id, kind, principal_delta_cents,
           bonus_delta_cents, staff_id, at, business_date, note
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'topup', 1, 0,
                   $5::uuid, $6, '2026-08-02', $7)`,
        [row.postMemberLedger, DEMO_ORG_ID, DEMO_STORE_ID, row.account, DEMO_ADMIN_ID, AT, PII],
      );
      await admin.query(
        `INSERT INTO points_ledger (
           id, org_id, store_id, account_id, kind, points_delta, staff_id, at, note
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'redeem', -1,
                   $5::uuid, $6, $7)`,
        [row.postPoints, DEMO_ORG_ID, DEMO_STORE_ID, row.account, DEMO_ADMIN_ID, AT, PII],
      );
      await admin.query(
        `INSERT INTO garment_incidents (
           id, org_id, store_id, order_id, garment_id, kind, note,
           compensation_cents, staff_id, created_at
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   'other', $6, 0, $7::uuid, $8)`,
        [
          row.postIncident,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          row.order,
          row.garment,
          PII,
          DEMO_ADMIN_ID,
          AT,
        ],
      );
      const guarded = await admin.query<
        Readonly<{
          payment_note: string | null;
          member_note: string | null;
          points_note: string;
          incident_note: string;
        }>
      >(
        `SELECT
           (SELECT note FROM payments WHERE id = $1::uuid) AS payment_note,
           (SELECT note FROM member_ledger WHERE id = $2::uuid) AS member_note,
           (SELECT note FROM points_ledger WHERE id = $3::uuid) AS points_note,
           (SELECT note FROM garment_incidents WHERE id = $4::uuid) AS incident_note`,
        [row.postPayment, row.postMemberLedger, row.postPoints, row.postIncident],
      );
      assert.deepEqual(guarded.rows[0], {
        payment_note: null,
        member_note: null,
        points_note: "privacy_redacted",
        incident_note: "privacy_redacted",
      });
      await assert.rejects(
        () =>
          admin.query(
            `INSERT INTO garment_photos (
               id, org_id, store_id, garment_id, order_id, kind, storage_key,
               byte_size, taken_at, created_by_staff_id
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                       'other', $6, 1, $7, $8::uuid)`,
            [
              row.postPhoto,
              DEMO_ORG_ID,
              DEMO_STORE_ID,
              row.garment,
              row.order,
              `synthetic/${row.postPhoto}.jpg`,
              AT,
              DEMO_ADMIN_ID,
            ],
          ),
        /CUSTOMER_ERASED/u,
      );
      await assert.rejects(
        () =>
          admin.query(
            `INSERT INTO print_jobs (
               id, org_id, store_id, order_id, ticket_no, kind, status, created_at, updated_at
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PII', 'xp58', 'queued', $5, $5)`,
            [row.postPrint, DEMO_ORG_ID, DEMO_STORE_ID, row.order, AT],
          ),
        /CUSTOMER_ERASED/u,
      );
    } finally {
      await admin.query("DELETE FROM ai_pending_actions WHERE nonce = ANY($1::uuid[])", [
        [row.pending, row.revivedPending],
      ]);
      await admin.query("DELETE FROM customer_privacy_events WHERE customer_id = $1::uuid", [
        row.customer,
      ]);
      await admin.query("DELETE FROM audit_log WHERE id = $1::uuid", [row.audit]);
      await admin.query("DELETE FROM edge_replay_records WHERE id = $1::uuid", [row.edgeReplay]);
      await admin.query(
        "DELETE FROM command_idempotency WHERE org_id = $1::uuid AND idempotency_key = $2::uuid",
        [DEMO_ORG_ID, row.idempotencyKey],
      );
      await admin.query("DELETE FROM offline_grants WHERE id = $1::uuid", [row.edgeGrant]);
      await admin.query("DELETE FROM edge_devices WHERE device_id = $1::uuid", [row.edgeDevice]);
      await admin.query("DELETE FROM coupon_redemption_reversals WHERE id = $1::uuid", [
        row.couponReversal,
      ]);
      await admin.query("DELETE FROM coupon_redemptions WHERE id = $1::uuid", [
        row.couponRedemption,
      ]);
      await admin.query("DELETE FROM coupon_grants WHERE id = $1::uuid", [row.couponGrant]);
      await admin.query("DELETE FROM punch_card_ledger WHERE id = $1::uuid", [row.punchLedger]);
      await admin.query("DELETE FROM punch_cards WHERE id = $1::uuid", [row.punchCard]);
      await admin.query("DELETE FROM points_ledger WHERE account_id = $1::uuid", [row.account]);
      await admin.query("DELETE FROM member_memberships WHERE account_id = $1::uuid", [
        row.account,
      ]);
      await admin.query("DELETE FROM member_ledger WHERE account_id = $1::uuid", [row.account]);
      await admin.query("DELETE FROM member_accounts WHERE id = $1::uuid", [row.account]);
      await admin.query("DELETE FROM garment_photos WHERE id = $1::uuid", [row.photo]);
      await admin.query("DELETE FROM garment_incidents WHERE garment_id = $1::uuid", [row.garment]);
      await admin.query("DELETE FROM garment_status_log WHERE garment_id = $1::uuid", [
        row.garment,
      ]);
      await admin.query("DELETE FROM payments WHERE order_id = $1::uuid", [row.order]);
      await admin.query("DELETE FROM garments WHERE id = $1::uuid", [row.garment]);
      await admin.query("DELETE FROM order_lines WHERE id = $1::uuid", [row.line]);
      await admin.query("DELETE FROM orders WHERE id = $1::uuid", [row.order]);
      await admin.query("DELETE FROM customer_erasure_tombstones WHERE customer_id = $1::uuid", [
        row.customer,
      ]);
      await admin.query("DELETE FROM customers WHERE id = $1::uuid", [row.customer]);
      await admin.query("DELETE FROM member_punch_types WHERE id = $1::uuid", [
        row.punchDefinition,
      ]);
      await admin.query("DELETE FROM coupons WHERE id = $1::uuid", [row.couponDefinition]);
      await Promise.all([app.end(), admin.end()]);
    }
  },
);
