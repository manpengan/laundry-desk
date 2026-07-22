import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPickupBody,
  buildReceiveBody,
  isValidPhone,
  newLineDraft,
  parseNonNegCents,
  unwrapCommandResult,
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

test("buildPickupBody empty garment list means all pickable", () => {
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

test("unwrapCommandResult reads bus envelope result", () => {
  const nested = unwrapCommandResult<{ ticket_no: string }>({
    execution: "executed",
    result: { ticket_no: "20260722-0001" },
  });
  assert.equal(nested?.ticket_no, "20260722-0001");
  const bare = unwrapCommandResult<{ order_id: string }>({ order_id: "x" });
  assert.equal(bare?.order_id, "x");
});
