import assert from "node:assert/strict";
import test from "node:test";

import { CATALOG_AUDIT_ACTION_LABEL, readCatalogAuditRows } from "./catalog-audit-model.js";

test("readCatalogAuditRows accepts only the safe fixed projection", () => {
  const safe = {
    id: "audit-1",
    at_epoch_s: 1_700_000_000,
    staff_id: null,
    action: "reactivated",
    codes: ["wash_shirt"],
  };
  assert.deepEqual(readCatalogAuditRows({ result: { items: [safe] } }), [safe]);
  assert.equal(CATALOG_AUDIT_ACTION_LABEL.reactivated, "启用");
  assert.deepEqual(
    readCatalogAuditRows({
      result: {
        items: [
          { ...safe, action: "deleted" },
          { ...safe, codes: "wash_shirt" },
          { ...safe, before_json: "secret", id: undefined },
        ],
      },
    }),
    [],
  );
});

test("readCatalogAuditRows degrades malformed envelopes to an empty list", () => {
  for (const value of [null, undefined, {}, { result: {} }, { result: { items: null } }]) {
    assert.deepEqual(readCatalogAuditRows(value), []);
  }
});
