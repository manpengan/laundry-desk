import assert from "node:assert/strict";
import test from "node:test";

import {
  appendUniqueBarcode,
  nextFactoryCheckpoint,
  parseFactoryBatchList,
} from "./factory-handoff-model.js";

test("factory handoff model follows the four custody checkpoints", () => {
  assert.equal(nextFactoryCheckpoint("packing"), "store_dispatch");
  assert.equal(nextFactoryCheckpoint("store_dispatched"), "factory_receive");
  assert.equal(nextFactoryCheckpoint("factory_received"), "factory_dispatch");
  assert.equal(nextFactoryCheckpoint("factory_dispatched"), "store_receive");
  assert.equal(nextFactoryCheckpoint("store_received"), null);
  assert.equal(nextFactoryCheckpoint("cancelled"), null);
});

test("scanner input is trimmed and duplicate scans stay idempotent", () => {
  const once = appendUniqueBarcode(Object.freeze([]), "  BAR-001  ");
  assert.deepEqual(once, ["BAR-001"]);
  assert.equal(appendUniqueBarcode(once, "BAR-001"), once);
});

test("factory list parser accepts bounded evidence and rejects customer fields", () => {
  const valid = {
    batches: [],
    eligible_garments: [
      {
        garment_id: "10000000-0000-4000-8000-000000000001",
        order_id: "10000000-0000-4000-8000-000000000002",
        ticket_no: "20260812-0001",
        barcode: "BAR-001",
        status: "received",
        custody_state: "store",
      },
    ],
  };
  assert.ok(parseFactoryBatchList({ result: valid }));
  assert.equal(
    parseFactoryBatchList({
      result: {
        ...valid,
        eligible_garments: [{ ...valid.eligible_garments[0], customer_name: "不应出现" }],
      },
    }),
    null,
  );
});
