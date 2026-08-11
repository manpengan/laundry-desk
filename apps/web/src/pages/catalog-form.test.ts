import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCatalogUpsertBody,
  catalogFormFromRow,
  EMPTY_CATALOG_FORM,
  readCatalogRows,
  type CatalogFormState,
} from "./catalog-form.js";

const valid: CatalogFormState = Object.freeze({
  code: "wash_shirt",
  name: "水洗衬衫",
  service_code: "Wash",
  category_code: " Shirt ",
  price_text: " 1500 ",
  mnemonic: " xs ",
  is_active: true,
  sort_order: null,
  expected_version: 0,
});

test("buildCatalogUpsertBody trims, lowercases taxonomy and keeps integer fen", () => {
  const built = buildCatalogUpsertBody(valid);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.body, {
    code: "wash_shirt",
    name: "水洗衬衫",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1500,
    mnemonic: "xs",
    is_active: true,
    expected_version: 0,
  });
});

test("buildCatalogUpsertBody omits an empty mnemonic rather than sending an empty string", () => {
  const built = buildCatalogUpsertBody({ ...valid, mnemonic: "   " });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal("mnemonic" in built.body, false);
});

test("buildCatalogUpsertBody rejects out-of-range, float, negative and non-numeric prices", () => {
  for (const priceText of ["2147483648", "15.5", "-1", "", "1e3", "１５００"]) {
    const built = buildCatalogUpsertBody({ ...valid, price_text: priceText });
    assert.equal(built.ok, false, `price ${priceText} must be rejected`);
  }
});

test("buildCatalogUpsertBody rejects malformed codes and empty required fields", () => {
  assert.equal(buildCatalogUpsertBody({ ...valid, code: "bad code" }).ok, false);
  assert.equal(buildCatalogUpsertBody({ ...valid, code: "_leading" }).ok, false);
  assert.equal(buildCatalogUpsertBody({ ...valid, name: "  " }).ok, false);
  assert.equal(buildCatalogUpsertBody({ ...valid, service_code: "" }).ok, false);
  assert.equal(buildCatalogUpsertBody(EMPTY_CATALOG_FORM).ok, false);
});

test("catalogFormFromRow round-trips an existing row back into an editable form", () => {
  const form = catalogFormFromRow({
    code: "dry_coat",
    name: "干洗大衣",
    service_code: "dry",
    category_code: "coat",
    unit_price_cents: 4800,
    is_active: false,
    sort_order: 3,
    version: 7,
    updated_at: 1_700_000_000,
  });
  assert.equal(form.price_text, "4800");
  assert.equal(form.mnemonic, "");
  assert.equal(form.is_active, false);
  assert.equal(form.expected_version, 7);
  const built = buildCatalogUpsertBody(form);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.body.unit_price_cents, 4800);
});

test("readCatalogRows unwraps result, drops malformed rows and never yields a non-array", () => {
  const row = {
    code: "wash_shirt",
    name: "水洗衬衫",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1500,
    is_active: true,
    sort_order: 0,
    version: 1,
    updated_at: 1_700_000_000,
  };
  assert.deepEqual(readCatalogRows({ result: { items: [row], total: 1 } }), [row]);
  assert.deepEqual(readCatalogRows({ items: [row] }), [row]);
  // A crash here previously blanked the whole counter shell.
  for (const bad of [undefined, null, {}, { result: {} }, { result: { items: null } }, 42]) {
    assert.deepEqual(readCatalogRows(bad), []);
  }
  assert.deepEqual(readCatalogRows({ result: { items: [row, { code: "x" }, null] } }), [row]);
});
