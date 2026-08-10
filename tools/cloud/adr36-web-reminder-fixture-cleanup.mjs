import {
  reminderFixtureSqlPrelude,
  reminderFixtureSqlText,
  reminderFixtureTargetArrays,
} from "./adr36-web-reminder-fixture-data.mjs";

export function buildReminderFixtureCleanupSql(artifacts) {
  const arrays = reminderFixtureTargetArrays(artifacts);
  const expectedRows = artifacts.rows
    .map(
      (row) =>
        `(${reminderFixtureSqlText(row.customerId)}::uuid, ${reminderFixtureSqlText(row.orderId)}::uuid, ${reminderFixtureSqlText(row.orderLineId)}::uuid, ${reminderFixtureSqlText(row.garmentId)}::uuid, ${reminderFixtureSqlText(row.phone)}, ${reminderFixtureSqlText(row.note)})`,
    )
    .join(",\n");
  const afterJson = JSON.stringify({
    fixture: "reminder_history",
    run_id: artifacts.runId,
    order_count: artifacts.rows.length,
    synthetic: true,
    status: "cleaned",
  });
  return `${reminderFixtureSqlPrelude(artifacts)}
CREATE TEMP TABLE expected_fixture_cleanup (
  customer_id uuid, order_id uuid, line_id uuid, garment_id uuid, phone text, note text
) ON COMMIT DROP;
INSERT INTO expected_fixture_cleanup VALUES ${expectedRows};
DO $fixture$
DECLARE customer_count integer; order_count integer; line_count integer; garment_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM customers AS customer
    JOIN expected_fixture_cleanup AS fixture ON fixture.customer_id = customer.id
    WHERE customer.org_id IS DISTINCT FROM ${reminderFixtureSqlText(artifacts.orgId)}::uuid
       OR customer.phone IS DISTINCT FROM fixture.phone
       OR customer.note IS DISTINCT FROM fixture.note
  ) OR EXISTS (
    SELECT 1 FROM orders AS orders_row
    JOIN expected_fixture_cleanup AS fixture ON fixture.order_id = orders_row.id
    WHERE orders_row.org_id IS DISTINCT FROM ${reminderFixtureSqlText(artifacts.orgId)}::uuid
       OR orders_row.store_id IS DISTINCT FROM ${reminderFixtureSqlText(artifacts.storeId)}::uuid
       OR orders_row.customer_id IS DISTINCT FROM fixture.customer_id
       OR orders_row.note IS DISTINCT FROM fixture.note
  ) OR EXISTS (
    SELECT 1 FROM order_lines AS line
    JOIN expected_fixture_cleanup AS fixture ON fixture.line_id = line.id
    WHERE line.org_id IS DISTINCT FROM ${reminderFixtureSqlText(artifacts.orgId)}::uuid
       OR line.store_id IS DISTINCT FROM ${reminderFixtureSqlText(artifacts.storeId)}::uuid
       OR line.order_id IS DISTINCT FROM fixture.order_id
  ) OR EXISTS (
    SELECT 1 FROM garments AS garment
    JOIN expected_fixture_cleanup AS fixture ON fixture.garment_id = garment.id
    WHERE garment.org_id IS DISTINCT FROM ${reminderFixtureSqlText(artifacts.orgId)}::uuid
       OR garment.store_id IS DISTINCT FROM ${reminderFixtureSqlText(artifacts.storeId)}::uuid
       OR garment.order_id IS DISTINCT FROM fixture.order_id
       OR garment.order_line_id IS DISTINCT FROM fixture.line_id
  ) THEN RAISE EXCEPTION 'fixture cleanup ownership mismatch'; END IF;
  SELECT count(*) INTO customer_count FROM customers WHERE id = ANY(${arrays.customers});
  SELECT count(*) INTO order_count FROM orders WHERE id = ANY(${arrays.orders});
  SELECT count(*) INTO line_count FROM order_lines WHERE id = ANY(${arrays.lines});
  SELECT count(*) INTO garment_count FROM garments WHERE id = ANY(${arrays.garments});
  IF NOT ((customer_count = 0 AND order_count = 0 AND line_count = 0 AND garment_count = 0)
      OR (customer_count = 3 AND order_count = 3 AND line_count = 3 AND garment_count = 3)) THEN
    RAISE EXCEPTION 'fixture cleanup partial state';
  END IF;
END
$fixture$;
DELETE FROM notification_log WHERE org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
  AND store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid AND order_id = ANY(${arrays.orders});
DELETE FROM garments WHERE org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
  AND store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid AND id = ANY(${arrays.garments});
DELETE FROM order_lines WHERE org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
  AND store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid AND id = ANY(${arrays.lines});
DELETE FROM orders WHERE org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
  AND store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid AND id = ANY(${arrays.orders});
DELETE FROM customers WHERE org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
  AND id = ANY(${arrays.customers});
INSERT INTO audit_log (
  id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
  entity, entity_id, before_json, after_json, ip, device_id, at
) VALUES (
  ${reminderFixtureSqlText(artifacts.cleanupAuditId)}::uuid, ${reminderFixtureSqlText(artifacts.orgId)}::uuid,
  ${reminderFixtureSqlText(artifacts.storeId)}::uuid, ${reminderFixtureSqlText(artifacts.staffId)}::uuid,
  'maintenance', 'cloud.reminder_history_fixture.cleanup', ${reminderFixtureSqlText(artifacts.runId)}, false,
  'cloud_test_fixture', ${reminderFixtureSqlText(artifacts.runId)}, NULL, ${reminderFixtureSqlText(afterJson)}, NULL,
  ${reminderFixtureSqlText(artifacts.deviceId)}::uuid, clock_timestamp()
) ON CONFLICT (id) DO NOTHING;
DO $fixture$
BEGIN
  IF (SELECT count(*) FROM audit_log AS audit
      WHERE audit.id = ${reminderFixtureSqlText(artifacts.cleanupAuditId)}::uuid
        AND audit.org_id = ${reminderFixtureSqlText(artifacts.orgId)}::uuid
        AND audit.store_id = ${reminderFixtureSqlText(artifacts.storeId)}::uuid
        AND audit.staff_id = ${reminderFixtureSqlText(artifacts.staffId)}::uuid
        AND audit.device_id = ${reminderFixtureSqlText(artifacts.deviceId)}::uuid
        AND audit.via = 'maintenance'
        AND audit.command = 'cloud.reminder_history_fixture.cleanup'
        AND audit.idempotency_key = ${reminderFixtureSqlText(artifacts.runId)}
        AND audit.dry_run = false
        AND audit.entity = 'cloud_test_fixture'
        AND audit.entity_id = ${reminderFixtureSqlText(artifacts.runId)}
        AND audit.before_json IS NULL AND audit.ip IS NULL
        AND audit.after_json::jsonb = ${reminderFixtureSqlText(afterJson)}::jsonb) <> 1 THEN
    RAISE EXCEPTION 'fixture cleanup audit mismatch';
  END IF;
END
$fixture$;
SELECT 'ADR36_REMINDER_FIXTURE_CLEANED|${artifacts.runId}|3';
COMMIT;`;
}
