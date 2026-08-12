import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPickupBody,
  buildReceiveBody,
  isPickableGarmentStatus,
  isValidPhone,
  newLineDraft,
  parseHoldDraftId,
  parseNonNegCents,
  parseOrderGetResult,
  parseReceiveOrderResult,
  pickableGarmentIds,
  resizeGarmentDrafts,
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
    initial_payment_cents: "10.5",
    initial_payment_method: "cash",
    discount_cents: "0",
    urgent: false,
    freight: false,
    note: "",
    lines: [line],
  });
  assert.equal(bad.ok, false);

  const ok = buildReceiveBody({
    customer_phone: "13800000111",
    customer_name: "测试",
    initial_payment_cents: "500",
    initial_payment_method: "wechat",
    discount_cents: "100",
    urgent: true,
    freight: false,
    note: "急",
    lines: [
      {
        ...line,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1500,
        qty: "2",
        garments: Object.freeze([
          Object.freeze({
            ...line.garments[0]!,
            color: "白",
            brand: "甲牌",
            defects_text: "袖口污渍，纽扣松动",
            accessories_text: "腰带",
            note: "单独去渍",
            addon_codes: Object.freeze(["stain"]),
          }),
          Object.freeze({
            ...line.garments[0]!,
            key: "piece-2",
            color: "蓝",
            brand: "乙牌",
            addon_codes: Object.freeze([]),
          }),
        ]),
      },
    ],
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.body.initial_payment, { amount_cents: 500, method: "wechat" });
  assert.deepEqual(ok.body.customer_phone, "13800000111");
  assert.equal(ok.body.discount_cents, 100);
  assert.equal(ok.body.urgent, true);
  assert.equal(ok.body.freight, false);
  assert.equal("addon_cents" in ok.body, false);
  const lines = ok.body.lines as readonly {
    qty: number;
    unit_price_cents?: number;
    garments: readonly Record<string, unknown>[];
  }[];
  assert.equal(lines[0]?.qty, 2);
  assert.equal(lines[0]?.unit_price_cents, undefined);
  assert.deepEqual(lines[0]?.garments, [
    {
      color: "白",
      brand: "甲牌",
      defects: ["袖口污渍", "纽扣松动"],
      accessories: ["腰带"],
      note: "单独去渍",
      addon_codes: ["stain"],
    },
    { color: "蓝", brand: "乙牌" },
  ]);
  assert.equal(ok.previewLines[0]?.unit_price_cents, 1500);
});

test("garment draft resizing preserves existing details and enforces exact receive quantity", () => {
  const line = newLineDraft(0);
  const first = Object.freeze({ ...line.garments[0]!, color: "白", note: "保留" });
  const grown = resizeGarmentDrafts(Object.freeze([first]), 3, line.key);
  assert.equal(grown.length, 3);
  assert.equal(grown[0], first);
  assert.equal(grown[1]?.color, "");
  const shrunk = resizeGarmentDrafts(grown, 1, line.key);
  assert.deepEqual(shrunk, [first]);

  const mismatch = buildReceiveBody({
    customer_phone: "",
    customer_name: "",
    initial_payment_cents: "0",
    initial_payment_method: "cash",
    discount_cents: "0",
    urgent: false,
    freight: false,
    note: "",
    lines: [
      Object.freeze({
        ...line,
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1_500,
        qty: "2",
        garments: Object.freeze([first]),
      }),
    ],
  });
  assert.equal(mismatch.ok, false);
  if (mismatch.ok) return;
  assert.match(mismatch.message, /逐件信息与数量不一致/u);
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
  assert.deepEqual(ok.body.verification_barcodes, []);
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

test("buildPickupBody accepts selected garment ids and normalized verification barcodes", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const ok = buildPickupBody({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    collect_cents: "1000",
    garment_ids: [id],
    verification_barcodes: [" rack-001 "],
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.body.garment_ids, [id]);
  assert.deepEqual(ok.body.verification_barcodes, ["RACK-001"]);
});

test("buildPickupBody rejects duplicate verification barcodes", () => {
  const bad = buildPickupBody({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    collect_cents: "0",
    garment_ids: ["11111111-2222-4333-8444-555555555555"],
    verification_barcodes: ["abc", "ABC"],
  });
  assert.equal(bad.ok, false);
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

test("parseHoldDraftId accepts only a UUID returned by the server", () => {
  assert.equal(
    parseHoldDraftId({ draft_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  );
  assert.equal(parseHoldDraftId({ draft_id: "client-chosen" }), null);
});

test("parseReceiveOrderResult validates financials, garments and uniqueness", () => {
  const valid = {
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260811-0001",
    pickup_code: "P202608110001",
    payable_cents: 3_000,
    paid_cents: 500,
    balance_cents: 2_500,
    discount_cents: 300,
    discount_source: "customer",
    discount_bps: 1_000,
    waivers: {
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: true,
    },
    garment_count: 1,
    garments: [
      {
        garment_id: "11111111-2222-4333-8444-555555555555",
        barcode: "20260811-0001-01",
        status: "received",
        line_index: 0,
        seq: 1,
      },
    ],
  };
  assert.deepEqual(parseReceiveOrderResult(valid), valid);
  assert.equal(parseReceiveOrderResult({ ...valid, balance_cents: 2_499 }), null);
  assert.equal(parseReceiveOrderResult({ ...valid, garment_count: 2 }), null);
  assert.equal(parseReceiveOrderResult({ ...valid, discount_source: "browser" }), null);
  assert.equal(
    parseReceiveOrderResult({ ...valid, waivers: { ...valid.waivers, skip_ticket_print: 1 } }),
    null,
  );
  assert.equal(
    parseReceiveOrderResult({ ...valid, garments: [valid.garments[0], valid.garments[0]] }),
    null,
  );
});

const SAMPLE_GARMENTS: readonly OrderGetGarment[] = Object.freeze([
  Object.freeze({
    garment_id: "11111111-2222-4333-8444-555555555555",
    barcode: "ABC1",
    status: "received",
    line_index: 0,
    seq: 1,
    unit_price_cents: 1500,
    service_code: "wash",
    category_code: "shirt",
    color: "白",
    brand: "甲牌",
    defects: Object.freeze(["袖口污渍"]),
    accessories: Object.freeze(["腰带"]),
    note: "单独去渍",
    addons: Object.freeze([]),
    rack_zone: null,
    rack_slot: null,
  }),
  Object.freeze({
    garment_id: "22222222-3333-4444-8555-666666666666",
    barcode: "ABC2",
    status: "picked_up",
    line_index: 0,
    seq: 2,
    unit_price_cents: 1500,
    service_code: "wash",
    category_code: "shirt",
    color: null,
    brand: null,
    defects: Object.freeze([]),
    accessories: Object.freeze([]),
    note: null,
    addons: Object.freeze([]),
    rack_zone: null,
    rack_slot: null,
  }),
  Object.freeze({
    garment_id: "33333333-4444-4555-8666-777777777777",
    barcode: "ABC3",
    status: "racked",
    line_index: 1,
    seq: 1,
    unit_price_cents: 2000,
    service_code: "dry",
    category_code: "coat",
    color: "黑",
    brand: null,
    defects: Object.freeze([]),
    accessories: Object.freeze([]),
    note: null,
    addons: Object.freeze([]),
    rack_zone: "A",
    rack_slot: "01",
  }),
]);

test("isPickableGarmentStatus includes direct and verified fulfillment states", () => {
  assert.equal(isPickableGarmentStatus("received"), true);
  assert.equal(isPickableGarmentStatus("picked_up"), false);
  assert.equal(isPickableGarmentStatus("ready"), true);
  assert.equal(isPickableGarmentStatus("racked"), true);
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
    pickup_code: "P202607220001",
    status: "open",
    customer_phone: "13800000111",
    customer_name: "张三",
    customer_profile_version: 4,
    discount_source: "customer",
    discount_bps: 0,
    membership_version: null,
    tier: null,
    waivers: {
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: true,
    },
    payable_cents: 3500,
    paid_cents: 500,
    balance_cents: 3000,
    garments: SAMPLE_GARMENTS,
  });
  assert.ok(parsed);
  assert.equal(parsed?.ticket_no, "20260722-0001");
  assert.equal(parsed?.balance_cents, 3000);
  assert.equal(parsed?.garments.length, 3);
  assert.equal(parsed?.customer_profile_version, 4);
  assert.equal(parsed?.discount_source, "customer");
  assert.equal(parsed?.discount_bps, 0);
  assert.equal(parsed?.waivers.skip_ticket_print, true);
  assert.equal(parsed?.waivers.skip_label_print, false);
  assert.equal(parsed?.waivers.skip_rack_assignment, true);
  assert.equal(parseOrderGetResult({ ticket_no: "x" }), null);
  assert.equal(
    parseOrderGetResult({
      order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      status: "draft",
      ticket_no: null,
      pickup_code: null,
      payable_cents: 1,
      paid_cents: 0,
      balance_cents: 1,
      lines: [
        {
          line_index: 0,
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1,
          qty: 0,
          line_total_cents: 0,
          color: null,
          brand: null,
          garments: [],
        },
      ],
      garments: [],
    }),
    null,
  );
});

test("parseOrderGetResult rejects malformed policy snapshots", () => {
  const valid = {
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0001",
    pickup_code: "P202607220001",
    status: "open",
    payable_cents: 3500,
    paid_cents: 500,
    balance_cents: 3000,
    garments: SAMPLE_GARMENTS,
    customer_profile_version: 4,
    discount_source: "customer",
    discount_bps: 0,
    membership_version: null,
    tier: null,
    waivers: {
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: true,
    },
  };
  assert.ok(parseOrderGetResult(valid));
  assert.equal(parseOrderGetResult({ ...valid, discount_source: "unknown" }), null);
  assert.equal(parseOrderGetResult({ ...valid, discount_bps: 10_001 }), null);
  assert.equal(
    parseOrderGetResult({
      ...valid,
      waivers: { ...valid.waivers, skip_ticket_print: "yes" },
    }),
    null,
  );
});

test("parseOrderGetResult accepts only the zeroed projection of a cancelled order", () => {
  const cancelled = {
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0001",
    pickup_code: "P202607220001",
    status: "cancelled",
    original_cents: 3_500,
    payable_cents: 3_500,
    paid_cents: 0,
    balance_cents: 0,
    garments: SAMPLE_GARMENTS,
  };
  assert.equal(parseOrderGetResult(cancelled)?.status, "cancelled");
  assert.equal(parseOrderGetResult({ ...cancelled, balance_cents: 3_500 }), null);
});
