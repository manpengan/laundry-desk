import { createHash } from "node:crypto";

import { requireThat, requireUuid } from "./adr36-web-core.mjs";

export const REMINDER_FIXTURE_AGES = Object.freeze([31, 91, 181]);
const RUN_ID = /^ADR36-\d{8}T\d{6}(?:\d{3})?Z-[0-9a-f]{8}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function reminderFixtureSqlText(value) {
  requireThat(
    typeof value === "string" && !/[\u0000-\u001f\u007f]/u.test(value),
    "REMINDER_FIXTURE_VALUE_INVALID",
  );
  return `'${value.replaceAll("'", "''")}'`;
}

function fixtureUuid(runId, label) {
  const bytes = Buffer.from(createHash("sha256").update(`${runId}:${label}`, "utf8").digest());
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function syntheticPhone(runId, ageDays) {
  const digits = createHash("sha256")
    .update(`${runId}:phone:${ageDays}`, "utf8")
    .digest("hex")
    .replaceAll(/[a-f]/gu, "")
    .padEnd(8, "0")
    .slice(0, 8);
  return `199${digits}`;
}

function movedDate(now, days) {
  const value = new Date(now.getTime());
  value.setUTCDate(value.getUTCDate() - days);
  return value;
}

export function buildReminderFixtureArtifacts({ runId, now, session }) {
  requireThat(typeof runId === "string" && RUN_ID.test(runId), "REMINDER_FIXTURE_RUN_ID_INVALID");
  requireThat(
    now instanceof Date && Number.isFinite(now.getTime()),
    "REMINDER_FIXTURE_CLOCK_INVALID",
  );
  const orgId = requireUuid(session?.orgId, "REMINDER_FIXTURE_SESSION_INVALID");
  const storeId = requireUuid(session?.storeId, "REMINDER_FIXTURE_SESSION_INVALID");
  const staffId = requireUuid(session?.staffId, "REMINDER_FIXTURE_SESSION_INVALID");
  const deviceId = requireUuid(session?.deviceId, "REMINDER_FIXTURE_SESSION_INVALID");
  const suffix = runId.slice(-8);
  const rows = REMINDER_FIXTURE_AGES.map((ageDays) => {
    const createdAt = movedDate(now, ageDays);
    return Object.freeze({
      ageDays,
      customerId: fixtureUuid(runId, `customer:${ageDays}`),
      orderId: fixtureUuid(runId, `order:${ageDays}`),
      orderLineId: fixtureUuid(runId, `line:${ageDays}`),
      garmentId: fixtureUuid(runId, `garment:${ageDays}`),
      phone: syntheticPhone(runId, ageDays),
      customerName: `ADR36 Synthetic Reminder ${suffix} ${ageDays}`,
      note: `ADR36-REMINDER-HISTORY:${runId}:${ageDays}`,
      ticketNo: `RH-${suffix}-${ageDays}`,
      pickupCode: `PRH${suffix}${ageDays}`,
      barcode: `RH${suffix}${ageDays}`,
      createdAt: createdAt.toISOString(),
      businessDate: createdAt.toISOString().slice(0, 10),
    });
  });
  requireThat(
    new Set(rows.map((row) => row.phone)).size === rows.length,
    "REMINDER_FIXTURE_PHONE_COLLISION",
  );
  return Object.freeze({
    runId,
    now: now.toISOString(),
    orgId,
    storeId,
    staffId,
    deviceId,
    applyAuditId: fixtureUuid(runId, "audit:apply"),
    cleanupAuditId: fixtureUuid(runId, "audit:cleanup"),
    rows: Object.freeze(rows),
  });
}

function rowValues(artifacts, row) {
  const common = [artifacts.orgId, artifacts.storeId].map(reminderFixtureSqlText);
  return Object.freeze({
    customer: `(${reminderFixtureSqlText(row.customerId)}::uuid, ${common[0]}::uuid, ${reminderFixtureSqlText(row.phone)}, ${reminderFixtureSqlText(row.customerName)}, ${reminderFixtureSqlText(row.note)}, ${reminderFixtureSqlText(row.createdAt)}::timestamptz, ${reminderFixtureSqlText(row.createdAt)}::timestamptz)`,
    order: `(${reminderFixtureSqlText(row.orderId)}::uuid, ${common[0]}::uuid, ${common[1]}::uuid, ${reminderFixtureSqlText(row.ticketNo)}, ${reminderFixtureSqlText(row.pickupCode)}, 'open', ${reminderFixtureSqlText(row.customerId)}::uuid, ${reminderFixtureSqlText(row.phone)}, ${reminderFixtureSqlText(row.customerName)}, ${reminderFixtureSqlText(row.note)}, 1000, 1000, 0, 0, 0, 0, 1000, 0, 1000, ${reminderFixtureSqlText(row.businessDate)}, ${reminderFixtureSqlText(row.createdAt)}::timestamptz, ${reminderFixtureSqlText(row.createdAt)}::timestamptz, ${reminderFixtureSqlText(artifacts.staffId)}::uuid)`,
    line: `(${reminderFixtureSqlText(row.orderLineId)}::uuid, ${common[0]}::uuid, ${common[1]}::uuid, ${reminderFixtureSqlText(row.orderId)}::uuid, 0, 'uat_reminder', 'uat_history', 1000, 1, 1000)`,
    garment: `(${reminderFixtureSqlText(row.garmentId)}::uuid, ${common[0]}::uuid, ${common[1]}::uuid, ${reminderFixtureSqlText(row.orderId)}::uuid, ${reminderFixtureSqlText(row.orderLineId)}::uuid, 1, ${reminderFixtureSqlText(row.barcode)}, 'uat_reminder', 'uat_history', 1000, 'ready')`,
  });
}

export function reminderFixtureTargetArrays(artifacts) {
  const array = (field) =>
    `ARRAY[${artifacts.rows.map((row) => `${reminderFixtureSqlText(row[field])}::uuid`).join(", ")}]`;
  return Object.freeze({
    customers: array("customerId"),
    orders: array("orderId"),
    lines: array("orderLineId"),
    garments: array("garmentId"),
  });
}

export function reminderFixtureSqlPrelude(artifacts) {
  return `BEGIN;
SET LOCAL ROLE laundry_owner;
SELECT pg_advisory_xact_lock(hashtextextended('adr36-reminder-history-fixture', 0));
DO $fixture$
BEGIN
  IF current_database() <> 'laundry_v2' THEN
    RAISE EXCEPTION 'fixture database mismatch';
  END IF;
  IF inet_server_addr() IS NOT NULL AND host(inet_server_addr()) NOT IN ('127.0.0.1', '::1') THEN
    RAISE EXCEPTION 'fixture connection is not loopback';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM orgs AS org
    JOIN stores AS store ON store.org_id = org.id
    JOIN staffs AS staff ON staff.org_id = org.id
    JOIN staff_store_roles AS role
      ON role.org_id = org.id AND role.store_id = store.id AND role.staff_id = staff.id
    WHERE org.id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
      AND org.code = 'local'
      AND store.id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid
      AND store.code = 'main'
      AND staff.id = ${reminderFixtureSqlText(artifacts.staffId)}::uuid
      AND staff.is_active AND role.is_active AND role.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'fixture authority mismatch';
  END IF;
END
$fixture$;`;
}

export function buildReminderFixtureApplySql(artifacts) {
  const values = artifacts.rows.map((row) => rowValues(artifacts, row));
  const arrays = reminderFixtureTargetArrays(artifacts);
  const afterJson = JSON.stringify({
    fixture: "reminder_history",
    run_id: artifacts.runId,
    ages_days: REMINDER_FIXTURE_AGES,
    order_count: artifacts.rows.length,
    synthetic: true,
  });
  return `${reminderFixtureSqlPrelude(artifacts)}
DO $fixture$
BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE id = ANY(${arrays.customers}))
     OR EXISTS (SELECT 1 FROM orders WHERE id = ANY(${arrays.orders}))
     OR EXISTS (SELECT 1 FROM order_lines WHERE id = ANY(${arrays.lines}))
     OR EXISTS (SELECT 1 FROM garments WHERE id = ANY(${arrays.garments})) THEN
    RAISE EXCEPTION 'fixture identifier collision';
  END IF;
END
$fixture$;
INSERT INTO customers (id, org_id, phone, name, note, created_at, updated_at)
VALUES ${values.map((value) => value.customer).join(",\n")};
INSERT INTO orders (
  id, org_id, store_id, ticket_no, pickup_code, status, customer_id,
  customer_phone, customer_name, note, subtotal_cents, original_cents,
  discount_cents, addon_cents, urgent_cents, freight_cents, payable_cents,
  paid_cents, balance_cents, business_date, created_at, updated_at, created_by_staff_id
) VALUES ${values.map((value) => value.order).join(",\n")};
INSERT INTO order_lines (
  id, org_id, store_id, order_id, line_index, service_code, category_code,
  unit_price_cents, qty, line_total_cents
) VALUES ${values.map((value) => value.line).join(",\n")};
INSERT INTO garments (
  id, org_id, store_id, order_id, order_line_id, seq, barcode,
  service_code, category_code, unit_price_cents, status
) VALUES ${values.map((value) => value.garment).join(",\n")};
INSERT INTO audit_log (
  id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
  entity, entity_id, before_json, after_json, ip, device_id, at
) VALUES (
  ${reminderFixtureSqlText(artifacts.applyAuditId)}::uuid, ${reminderFixtureSqlText(artifacts.orgId)}::uuid,
  ${reminderFixtureSqlText(artifacts.storeId)}::uuid, ${reminderFixtureSqlText(artifacts.staffId)}::uuid,
  'maintenance', 'cloud.reminder_history_fixture.apply', ${reminderFixtureSqlText(artifacts.runId)}, false,
  'cloud_test_fixture', ${reminderFixtureSqlText(artifacts.runId)}, NULL, ${reminderFixtureSqlText(afterJson)}, NULL,
  ${reminderFixtureSqlText(artifacts.deviceId)}::uuid, ${reminderFixtureSqlText(artifacts.now)}::timestamptz
);
SELECT 'ADR36_REMINDER_FIXTURE_APPLIED|${artifacts.runId}|3';
COMMIT;`;
}

export function buildReminderFixtureVerifySql(artifacts, evidence) {
  const batches = evidence.batches
    .map(
      (batch) =>
        `(${reminderFixtureSqlText(batch.batchId)}::uuid, ${batch.ageDays}, ${reminderFixtureSqlText(batch.sha256)}, ${batch.orderCount})`,
    )
    .join(",\n");
  const expectedRows = artifacts.rows
    .map(
      (row) =>
        `(${reminderFixtureSqlText(row.orderId)}::uuid, ${reminderFixtureSqlText(row.garmentId)}::uuid, ${row.ageDays}, ${reminderFixtureSqlText(row.createdAt)}::timestamptz)`,
    )
    .join(",\n");
  const applyAfterJson = JSON.stringify({
    fixture: "reminder_history",
    run_id: artifacts.runId,
    ages_days: REMINDER_FIXTURE_AGES,
    order_count: artifacts.rows.length,
    synthetic: true,
  });
  return `${reminderFixtureSqlPrelude(artifacts)}
CREATE TEMP TABLE expected_batches (batch_id uuid, age_days integer, export_sha256 text, order_count integer) ON COMMIT DROP;
INSERT INTO expected_batches VALUES ${batches};
CREATE TEMP TABLE expected_fixture (order_id uuid, garment_id uuid, age_days integer, created_at timestamptz) ON COMMIT DROP;
INSERT INTO expected_fixture VALUES ${expectedRows};
DO $fixture$
DECLARE invalid_count integer;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM expected_batches AS expected
  WHERE NOT EXISTS (
    SELECT 1 FROM notification_log AS log
    WHERE log.org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
      AND log.store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid
      AND log.batch_id = expected.batch_id
    GROUP BY log.batch_id
    HAVING count(*) = expected.order_count
       AND count(DISTINCT log.order_id) = expected.order_count
       AND bool_and(log.export_sha256 = expected.export_sha256)
       AND bool_and(log.channel = 'manual' AND log.status = 'list_generated' AND log.cost_cents = 0)
       AND bool_and(EXISTS (
         SELECT 1 FROM expected_fixture AS fixture
         WHERE fixture.order_id = log.order_id AND fixture.age_days >= expected.age_days
       ))
  );
  IF invalid_count <> 0 THEN RAISE EXCEPTION 'fixture notification evidence mismatch'; END IF;
  IF (SELECT count(*) FROM orders AS orders_row
      JOIN expected_fixture AS fixture ON fixture.order_id = orders_row.id
      WHERE orders_row.org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
        AND orders_row.store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid
        AND orders_row.status = 'open' AND orders_row.created_at = fixture.created_at
        AND orders_row.customer_phone ~ '^1[3-9][0-9]{9}$'
        AND orders_row.note = ${reminderFixtureSqlText(`ADR36-REMINDER-HISTORY:${artifacts.runId}:`)} || fixture.age_days::text) <> 3 THEN
    RAISE EXCEPTION 'fixture order proof mismatch';
  END IF;
  IF (SELECT count(*) FROM garments AS garment
      JOIN expected_fixture AS fixture ON fixture.garment_id = garment.id
      WHERE garment.order_id = fixture.order_id AND garment.status = 'ready') <> 3 THEN
    RAISE EXCEPTION 'fixture garment proof mismatch';
  END IF;
  IF (SELECT count(*) FROM audit_log AS audit
      WHERE audit.id = ${reminderFixtureSqlText(artifacts.applyAuditId)}::uuid
        AND audit.org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
        AND audit.store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid
        AND audit.staff_id = ${reminderFixtureSqlText(artifacts.staffId)}::uuid
        AND audit.device_id = ${reminderFixtureSqlText(artifacts.deviceId)}::uuid
        AND audit.via = 'maintenance'
        AND audit.command = 'cloud.reminder_history_fixture.apply'
        AND audit.idempotency_key = ${reminderFixtureSqlText(artifacts.runId)}
        AND audit.dry_run = false
        AND audit.entity = 'cloud_test_fixture'
        AND audit.entity_id = ${reminderFixtureSqlText(artifacts.runId)}
        AND audit.before_json IS NULL AND audit.ip IS NULL
        AND audit.after_json::jsonb = ${reminderFixtureSqlText(applyAfterJson)}::jsonb) <> 1 THEN
    RAISE EXCEPTION 'fixture audit proof mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM expected_batches AS expected
    WHERE (
      SELECT count(*) FROM audit_log AS audit
      WHERE audit.org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
        AND audit.store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid
        AND audit.staff_id = ${reminderFixtureSqlText(artifacts.staffId)}::uuid
        AND audit.device_id = ${reminderFixtureSqlText(artifacts.deviceId)}::uuid
        AND audit.via = 'ui'
        AND audit.command = 'notification.manual_list.create'
        AND audit.entity = 'notification_manual_list'
        AND audit.entity_id = expected.batch_id::text
        AND audit.dry_run = false
        AND audit.before_json IS NULL AND audit.ip IS NULL
        AND audit.after_json::jsonb ->> 'batch_id' = expected.batch_id::text
        AND (audit.after_json::jsonb ->> 'order_count')::integer = expected.order_count
        AND (audit.after_json::jsonb ->> 'recipient_count')::integer = expected.order_count
        AND audit.after_json::jsonb ->> 'grouping' = 'order'
        AND audit.after_json::jsonb ->> 'content_sha256' = expected.export_sha256
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'manual list audit proof mismatch';
  END IF;
END
$fixture$;
SELECT 'ADR36_REMINDER_FIXTURE_VERIFIED|${artifacts.runId}|3';
COMMIT;`;
}

export function validateReminderFixtureEvidence(value) {
  requireThat(
    Array.isArray(value?.batches) && value.batches.length === 3,
    "REMINDER_FIXTURE_EVIDENCE_INVALID",
  );
  const batches = value.batches.map((batch, index) => {
    const ageDays = [30, 90, 180][index];
    requireThat(
      batch?.ageDays === ageDays &&
        requireUuid(batch.batchId, "REMINDER_FIXTURE_EVIDENCE_INVALID") &&
        typeof batch.sha256 === "string" &&
        SHA256.test(batch.sha256) &&
        batch.orderCount === [3, 2, 1][index] &&
        batch.recipientCount === batch.orderCount,
      "REMINDER_FIXTURE_EVIDENCE_INVALID",
    );
    return Object.freeze({ ...batch, ageDays });
  });
  return Object.freeze({ batches: Object.freeze(batches) });
}
