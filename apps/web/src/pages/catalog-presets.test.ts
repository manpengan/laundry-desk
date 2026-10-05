import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_PRESETS, catalogPresetForm } from "./catalog-presets.js";
import { buildCatalogUpsertBody } from "./catalog-form.js";

test("Chinese catalog starters require an explicit store price and submit valid codes", () => {
  for (const preset of CATALOG_PRESETS) {
    const form = catalogPresetForm(preset.id);
    assert.ok(form);
    assert.equal(form.price_text, "");
    assert.equal(buildCatalogUpsertBody(form).ok, false);
    const built = buildCatalogUpsertBody({ ...form, price_text: "2550" });
    assert.equal(built.ok, true);
    if (built.ok) assert.equal(built.body.unit_price_cents, 2550);
  }
  assert.equal(catalogPresetForm("unknown"), null);
});
