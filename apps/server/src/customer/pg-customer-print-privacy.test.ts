import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";

import type { PrintSnapshot } from "@laundry/contracts";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { hashPrintSnapshot } from "../print/snapshot.js";
import { createPgCustomerPrivacyOperations } from "./pg-customer-privacy-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

function printSnapshot(orderId: string, ticketNo: string): PrintSnapshot {
  return Object.freeze({
    version: 1,
    store_name: "Privacy Test Store",
    store_phone: null,
    order_id: orderId,
    ticket_no: ticketNo,
    received_at: "2026-08-01T00:00:00.000Z",
    customer_name: "Privacy Customer",
    customer_phone: "13800008888",
    note: "Call Privacy Customer on arrival",
    lines: Object.freeze([
      Object.freeze({
        line_index: 0,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 500,
        qty: 1,
        line_total_cents: 500,
        color: null,
        brand: null,
      }),
    ]),
    totals: Object.freeze({
      original_cents: 500,
      discount_cents: 0,
      addon_cents: 0,
      urgent_cents: 0,
      freight_cents: 0,
      payable_cents: 500,
      paid_cents: 500,
      balance_cents: 0,
    }),
    payment_methods: Object.freeze(["cash" as const]),
  });
}

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
        reason: "Customer requested a complete export",
        event_id: exportEventId,
        now: 1_775_174_500,
      });
      const exportedOrder = exported?.orders[0];
      assert.ok(exportedOrder);
      assert.equal(exportedOrder.note, "Call Privacy Customer on arrival");
      assert.equal(exportedOrder.print_job_count, 1);
      assert.equal(exportedOrder.print_jobs_truncated, false);
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
          reason: "Queued print copy must block anonymization",
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
          reason: "In-flight print copy must block anonymization",
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

      const anonymized = await privacy.anonymize({
        customer_id: customerId,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        reason: "Customer confirmed irreversible anonymization",
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
      await assert.rejects(
        () =>
          adminPool.query("UPDATE print_jobs SET snapshot_json = $2::jsonb WHERE id = $1::uuid", [
            printJobId,
            JSON.stringify(snapshot),
          ]),
        /print snapshot is immutable except for terminal privacy purge/u,
      );
    } finally {
      await adminPool.query("DELETE FROM customer_privacy_events WHERE customer_id = $1::uuid", [
        customerId,
      ]);
      await adminPool.query("DELETE FROM print_jobs WHERE id = $1::uuid", [printJobId]);
      await adminPool.query("DELETE FROM orders WHERE id = $1::uuid", [orderId]);
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
