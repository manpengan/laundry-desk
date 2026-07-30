import assert from "node:assert/strict";
import test from "node:test";

import {
  createCustomerPrivacyExportFile,
  parseCustomerPrivacyEvents,
  parseCustomerPrivacyExport,
  parseCustomerPrivacyStatus,
} from "./customer-privacy.js";

const EXPORT = Object.freeze({
  format_version: 1 as const,
  exported_at: 1_700_000_100,
  customer: Object.freeze({
    customer_id: "11111111-1111-4111-8111-111111111111",
    phone: "13800000111",
    name: '=HYPERLINK("bad")',
    note: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_050,
  }),
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
          reason: "客户申请",
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
  assert.equal(file.filename.endsWith(".csv"), false);
});
