import assert from "node:assert/strict";
import test from "node:test";

import {
  createCustomerPrivacyExportFile,
  parseCustomerPrivacyEvents,
  parseCustomerPrivacyExport,
  parseCustomerPrivacyStatus,
} from "./customer-privacy.js";

const EXPORT = Object.freeze({
  format_version: 2 as const,
  exported_at: 1_700_000_100,
  customer: Object.freeze({
    customer_id: "11111111-1111-4111-8111-111111111111",
    phone: "13800000111",
    name: '=HYPERLINK("bad")',
    note: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_050,
  }),
  canonical_customers: Object.freeze([
    Object.freeze({
      customer_id: "11111111-1111-4111-8111-111111111111",
      phone: "13800000111",
      name: '=HYPERLINK("bad")',
      note: null,
      merged_into_id: null,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_050,
    }),
  ]),
  canonical_customer_count: 1,
  profile: Object.freeze({
    customer_id: "11111111-1111-4111-8111-111111111111",
    service_note: "canonical service note",
  }),
  profiles: Object.freeze([
    Object.freeze({
      customer_id: "11111111-1111-4111-8111-111111111111",
      service_note: "canonical service note",
    }),
    Object.freeze({
      customer_id: "22222222-2222-4222-8222-222222222222",
      service_note: "merged source service note",
    }),
  ]),
  profile_count: 2,
  profiles_truncated: false,
  addresses: Object.freeze([Object.freeze({ address: "合成测试路 1 号" })]),
  address_count: 1,
  addresses_truncated: false,
  retired_address_count: 1,
  identifiers: Object.freeze([Object.freeze({ kind: "tag", value: "SYNTHETIC-TAG" })]),
  identifier_count: 1,
  identifiers_truncated: false,
  retired_identifier_count: 1,
  related_narratives: Object.freeze([
    Object.freeze({
      source: "payment",
      entity_id: "payment-1",
      payload: Object.freeze({ note: "仅姓名备注" }),
    }),
  ]),
  related_narrative_count: 1,
  related_narratives_truncated: false,
  retained_garment_photo_count: 2,
  notification_deliveries: Object.freeze([
    Object.freeze({ delivery_id: "delivery-1", status: "delivered" }),
  ]),
  notification_delivery_count: 1,
  notification_deliveries_truncated: false,
  factory_handoff_evidence: Object.freeze([
    Object.freeze({ event_type: "checkpoint", checkpoint: "factory_receive" }),
  ]),
  factory_handoff_evidence_count: 1,
  factory_handoff_evidence_truncated: false,
  orders: Object.freeze([Object.freeze({ order_id: "order-1", payable_cents: 5000 })]),
  order_count: 1,
  truncated: false,
});

test("parses bounded customer privacy status and events", () => {
  assert.deepEqual(
    parseCustomerPrivacyStatus({
      execution: "executed",
      result: {
        customer_id: EXPORT.customer.customer_id,
        active_order_count: 0,
        retained_order_count: 1,
        photo_count: 2,
        latest_order_at: 1_700_000_000,
        anonymization_eligible: true,
      },
    }),
    {
      customer_id: EXPORT.customer.customer_id,
      active_order_count: 0,
      retained_order_count: 1,
      photo_count: 2,
      latest_order_at: 1_700_000_000,
      anonymization_eligible: true,
    },
  );
  assert.deepEqual(
    parseCustomerPrivacyEvents({
      events: [
        {
          event_id: "22222222-2222-4222-8222-222222222222",
          customer_id: EXPORT.customer.customer_id,
          action: "exported",
          reason: "customer_request",
          affected_order_count: 1,
          created_at: 1_700_000_100,
        },
      ],
    })?.map((event) => event.action),
    ["exported"],
  );
  assert.equal(parseCustomerPrivacyStatus({ active_order_count: -1 }), null);
  assert.equal(parseCustomerPrivacyEvents({ events: [{ action: "deleted" }] }), null);
});

test("creates a JSON export without spreadsheet formula interpretation", () => {
  const parsed = parseCustomerPrivacyExport({ execution: "executed", result: EXPORT });
  assert.notEqual(parsed, null);
  if (parsed === null) return;
  const file = createCustomerPrivacyExportFile(parsed);
  assert.equal(
    file.filename,
    `customer-privacy-${EXPORT.customer.customer_id}-${EXPORT.exported_at}.json`,
  );
  assert.equal(JSON.parse(file.contents).customer.phone, "13800000111");
  assert.equal(JSON.parse(file.contents).customer.name, '=HYPERLINK("bad")');
  assert.equal(JSON.parse(file.contents).profiles[1].service_note, "merged source service note");
  assert.equal(JSON.parse(file.contents).addresses[0].address, "合成测试路 1 号");
  assert.equal(JSON.parse(file.contents).related_narratives[0].payload.note, "仅姓名备注");
  assert.equal(JSON.parse(file.contents).retained_garment_photo_count, 2);
  assert.equal(JSON.parse(file.contents).notification_deliveries[0].status, "delivered");
  assert.equal(JSON.parse(file.contents).factory_handoff_evidence[0].checkpoint, "factory_receive");
  assert.equal(file.filename.endsWith(".csv"), false);
});
