import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  copyManualListPhones,
  downloadManualList,
  verifyManualListDigest,
} from "./pickup-reminder-export.js";
import {
  parseManualListResult,
  parsePickupReminderList,
  previewPickupReminderMessages,
} from "./pickup-reminder-model.js";

const candidate = Object.freeze({
  order_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ticket_no: "20260101-0001",
  customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  customer_name: "张三",
  customer_phone: "13800000000",
  garment_count: 2,
  balance_cents: 500,
  received_at: "2026-01-01T00:00:00.000Z",
  overdue_days: 218,
  garment_statuses: ["racked"],
  last_contact_at: null,
});

test("pickup reminder parser requires explicit unavailable external channels", () => {
  const parsed = parsePickupReminderList({
    generated_at: "2026-08-07T04:00:00.000Z",
    channels: { manual: true, sms: false, wechat: false },
    candidates: [candidate],
  });
  assert.equal(parsed?.candidates[0]?.customer_phone, "13800000000");
  assert.equal(
    parsePickupReminderList({
      generated_at: "2026-08-07T04:00:00.000Z",
      channels: { manual: true, sms: true, wechat: false },
      candidates: [],
    }),
    null,
  );
});

test("preview uses the same customer grouping and renderer as the server", () => {
  const parsed = parsePickupReminderList({
    generated_at: "2026-08-07T04:00:00.000Z",
    channels: { manual: true, sms: false, wechat: false },
    candidates: [
      candidate,
      {
        ...candidate,
        order_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        ticket_no: "20260102-0002",
      },
    ],
  });
  assert.ok(parsed);
  const messages = previewPickupReminderMessages(
    parsed.candidates,
    new Set(parsed.candidates.map((row) => row.order_id)),
    "customer",
    "{{tickets}} / {{garment_count}} / {{balance_cents}}",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message, "20260101-0001、20260102-0002 / 4 / 1000");
});

test("manual result parser and browser helper verify the server digest before download", async () => {
  const csv = "phone\r\n13800000000\r\n";
  const value = parseManualListResult({
    batch_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    generated_at: "2026-08-07T04:00:00.000Z",
    channel: "manual",
    status: "list_generated",
    cost_cents: 0,
    recipient_count: 1,
    order_count: 1,
    filename: "pickup-reminders-20260807-dddddddd.csv",
    content_sha256: createHash("sha256").update(csv, "utf8").digest("hex"),
    csv,
    rows: [
      {
        order_ids: [candidate.order_id],
        ticket_nos: [candidate.ticket_no],
        customer_name: "张三",
        customer_phone: "13800000000",
        garment_count: 2,
        balance_cents: 500,
        message: "请取衣",
      },
    ],
  });
  assert.ok(value);
  assert.equal(await verifyManualListDigest(value), true);
  assert.equal(downloadManualList(value), false);
  assert.equal(await copyManualListPhones(value), false);
});
