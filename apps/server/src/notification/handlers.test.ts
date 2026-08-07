import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { PickupReminderCandidate } from "@laundry/contracts";

import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { buildNotificationCsv, escapeNotificationCsvCell } from "./csv.js";
import { createNotificationHandlers } from "./handlers.js";
import type { NotificationLogWrite, NotificationStore } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-08-07T04:00:00.000Z");

const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});

const CANDIDATE: PickupReminderCandidate = {
  order_id: ORDER_ID,
  ticket_no: "20260101-0001",
  customer_id: CUSTOMER_ID,
  customer_name: "=危险姓名",
  customer_phone: "13800000000",
  garment_count: 2,
  balance_cents: 500,
  received_at: "2026-01-01T00:00:00.000Z",
  overdue_days: 218,
  garment_statuses: ["racked"],
  last_contact_at: null,
};

function actor(permissions: readonly string[]): ActorContext {
  return Object.freeze({
    staffId: STAFF_ID,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze([...permissions]),
  });
}

async function run(
  handler: CommandHandler,
  parsed: Readonly<Record<string, unknown>>,
  permissions: readonly string[] = ["customer_read"],
) {
  return handler(
    Object.freeze({
      client: new FakeSqlClient(),
      tenant: TENANT,
      actor: actor(permissions),
      parsed,
    }) as unknown as Parameters<CommandHandler>[0],
  );
}

function fakeStore(options: { stale?: boolean } = {}) {
  const writes: NotificationLogWrite[] = [];
  const store: NotificationStore = Object.freeze({
    listPickupReminders: async (request) =>
      Object.freeze(request.orderIds !== undefined && options.stale === true ? [] : [CANDIDATE]),
    lockOrders: async (_client, _tenant, ids) => ids.length,
    appendManualList: async (_client, _tenant, rows) => {
      writes.push(...rows);
    },
  });
  return { store, writes };
}

const hasCode =
  (code: string) =>
  (error: unknown): boolean => {
    assert.ok(error instanceof HandlerCommandError);
    assert.equal(error.commandError.code, code);
    return true;
  };

test("pickup reminder query exposes only the explicit manual channel", async () => {
  const { store } = fakeStore();
  const handlers = createNotificationHandlers({ store, now: () => NOW });
  const outcome = await run(handlers["notification.pickup_reminders.list"], {
    min_age_days: 180,
    unpaid_only: true,
    garment_statuses: ["racked"],
  });
  const result = outcome.result as Readonly<Record<string, unknown>>;
  assert.deepEqual(result.channels, { manual: true, sms: false, wechat: false });
  assert.deepEqual(result.candidates, [CANDIDATE]);
});

test("notification handlers require customer_read even when called directly", async () => {
  const { store } = fakeStore();
  const handlers = createNotificationHandlers({ store, now: () => NOW });
  await assert.rejects(
    () => run(handlers["notification.pickup_reminders.list"], {}, ["order_write"]),
    hasCode("PERMISSION_DENIED"),
  );
});

test("manual list revalidates, hashes and appends one evidence row per order", async () => {
  const { store, writes } = fakeStore();
  const handlers = createNotificationHandlers({ store, now: () => NOW });
  const outcome = await run(handlers["notification.manual_list.create"], {
    order_ids: [ORDER_ID],
    group_by: "order",
    message_template: "订单{{tickets}}共{{garment_count}}件，欠{{balance_cents}}分",
    format: "csv",
    min_age_days: 180,
    unpaid_only: true,
    garment_statuses: ["racked"],
  });
  const result = outcome.result as Readonly<{
    status: string;
    content_sha256: string;
    csv: string;
    rows: readonly Readonly<{ customer_phone: string; message: string }>[];
  }>;
  assert.equal(result.status, "list_generated");
  assert.equal(result.rows[0]?.customer_phone, "13800000000");
  assert.equal(result.rows[0]?.message, "订单20260101-0001共2件，欠500分");
  assert.equal(
    result.content_sha256,
    createHash("sha256").update(result.csv, "utf8").digest("hex"),
  );
  assert.match(result.csv, /'=危险姓名/u);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.exportSha256, result.content_sha256);
  assert.doesNotMatch(JSON.stringify(outcome.audit), /13800000000|危险姓名|订单2026/u);
});

test("manual list rejects the entire batch when a frozen candidate became stale", async () => {
  const { store, writes } = fakeStore({ stale: true });
  const handlers = createNotificationHandlers({ store, now: () => NOW });
  await assert.rejects(
    () =>
      run(handlers["notification.manual_list.create"], {
        order_ids: [ORDER_ID],
        group_by: "order",
        message_template: "{{tickets}}",
        format: "csv",
        min_age_days: 180,
        unpaid_only: false,
        garment_statuses: ["ready", "racked"],
      }),
    hasCode("INVARIANT_FAILED"),
  );
  assert.equal(writes.length, 0);
});

test("CSV always quotes cells and hardens leading spreadsheet formulas", () => {
  assert.equal(escapeNotificationCsvCell(" =1+1"), '"\' =1+1"');
  const csv = buildNotificationCsv([
    {
      order_ids: [ORDER_ID],
      ticket_nos: ['T"1'],
      customer_name: "+formula",
      customer_phone: "13800000000",
      garment_count: 1,
      balance_cents: 0,
      message: "hello",
    },
  ]);
  assert.match(csv, /"'\+formula"/u);
  assert.match(csv, /"T""1"/u);
});
