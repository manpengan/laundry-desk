import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPickupBody,
  buildReceiveBody,
  isPickableGarmentStatus,
  isValidPhone,
  newLineDraft,
  parseNonNegCents,
  parseOrderGetResult,
  pickableGarmentIds,
  selectAllPickableIds,
  toggleGarmentSelection,
  unwrapCommandResult,
  type OrderGetGarment,
} from "./order-form.js";

test("parseNonNegCents accepts integer fen only", () => {
  assert.equal(parseNonNegCents("0"), 0);
  assert.equal(parseNonNegCents("1500"), 1500);
  assert.equal(parseNonNegCents("12.5"), null);
  assert.equal(parseNonNegCents("-1"), null);
  assert.equal(parseNonNegCents(""), null);
});

test("isValidPhone matches mainland mobile seed range", () => {
  assert.equal(isValidPhone("13800000111"), true);
  assert.equal(isValidPhone("12800000111"), false);
  assert.equal(isValidPhone("1380000011"), false);
});

test("buildReceiveBody rejects float money and empty lines", () => {
  const line = newLineDraft(0);
  const bad = buildReceiveBody({
    customer_phone: "",
    customer_name: "",
    paid_cents: "10.5",
    note: "",
    lines: [line],
  });
  assert.equal(bad.ok, false);

  const ok = buildReceiveBody({
    customer_phone: "13800000111",
    customer_name: "测试",
    paid_cents: "500",
    note: "急",
    lines: [{ ...line, unit_price_cents: "1500", qty: "2" }],
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.body.paid_cents, 500);
  assert.deepEqual(ok.body.customer_phone, "13800000111");
  const lines = ok.body.lines as readonly { qty: number; unit_price_cents: number }[];
  assert.equal(lines[0]?.qty, 2);
  assert.equal(lines[0]?.unit_price_cents, 1500);
});

test("buildPickupBody empty garment_ids_text means all pickable (legacy)", () => {
  const ok = buildPickupBody({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    collect_cents: "2000",
    garment_ids_text: "",
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.body.garment_ids, []);
  assert.equal(ok.body.collect_cents, 2000);
});

test("buildPickupBody empty multi-select selection errors", () => {
  const bad = buildPickupBody({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    collect_cents: "0",
    garment_ids: [],
  });
  assert.equal(bad.ok, false);
  if (bad.ok) return;
  assert.match(bad.message, /至少选择/);
});

test("buildPickupBody accepts selected garment ids", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const ok = buildPickupBody({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    collect_cents: "1000",
    garment_ids: [id],
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.body.garment_ids, [id]);
});

test("unwrapCommandResult reads bus envelope result", () => {
  const nested = unwrapCommandResult<{ ticket_no: string }>({
    execution: "executed",
    result: { ticket_no: "20260722-0001" },
  });
  assert.equal(nested?.ticket_no, "20260722-0001");
  const bare = unwrapCommandResult<{ order_id: string }>({ order_id: "x" });
  assert.equal(bare?.order_id, "x");
});

const SAMPLE_GARMENTS: readonly OrderGetGarment[] = Object.freeze([
  Object.freeze({
    garment_id: "11111111-2222-4333-8444-555555555555",
    barcode: "ABC1",
    status: "received",
    line_index: 0,
    seq: 0,
    unit_price_cents: 1500,
  }),
  Object.freeze({
    garment_id: "22222222-3333-4444-8555-666666666666",
    barcode: "ABC2",
    status: "picked_up",
    line_index: 0,
    seq: 1,
    unit_price_cents: 1500,
  }),
  Object.freeze({
    garment_id: "33333333-4444-4555-8666-777777777777",
    barcode: "ABC3",
    status: "received",
    line_index: 1,
    seq: 0,
    unit_price_cents: 2000,
  }),
]);

test("isPickableGarmentStatus only received under collapsed fulfillment", () => {
  assert.equal(isPickableGarmentStatus("received"), true);
  assert.equal(isPickableGarmentStatus("picked_up"), false);
  assert.equal(isPickableGarmentStatus("ready"), false);
  assert.equal(isPickableGarmentStatus("washing"), false);
});

test("pickableGarmentIds and select helpers", () => {
  const ids = pickableGarmentIds(SAMPLE_GARMENTS);
  assert.deepEqual(ids, [
    "11111111-2222-4333-8444-555555555555",
    "33333333-4444-4555-8666-777777777777",
  ]);
  const all = selectAllPickableIds(SAMPLE_GARMENTS);
  assert.equal(all.size, 2);
  assert.ok(all.has("11111111-2222-4333-8444-555555555555"));
  let sel = new Set<string>();
  sel = new Set(toggleGarmentSelection(sel, "11111111-2222-4333-8444-555555555555"));
  assert.equal(sel.size, 1);
  sel = new Set(toggleGarmentSelection(sel, "11111111-2222-4333-8444-555555555555"));
  assert.equal(sel.size, 0);
});

test("parseOrderGetResult accepts summary + garments", () => {
  const parsed = parseOrderGetResult({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0001",
    status: "open",
    customer_phone: "13800000111",
    customer_name: "张三",
    payable_cents: 3500,
    paid_cents: 500,
    balance_cents: 3000,
    garments: SAMPLE_GARMENTS,
  });
  assert.ok(parsed);
  assert.equal(parsed?.ticket_no, "20260722-0001");
  assert.equal(parsed?.balance_cents, 3000);
  assert.equal(parsed?.garments.length, 3);
  assert.equal(parseOrderGetResult({ ticket_no: "x" }), null);
});
