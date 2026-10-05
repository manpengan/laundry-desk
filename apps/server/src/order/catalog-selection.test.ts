import assert from "node:assert/strict";
import test from "node:test";
import { HandlerCommandError } from "../bus/types.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { requireLines, resolveServerPrices } from "./server-pricing.js";

const item = (code: string, name: string, price = 1500) => ({
  code,
  name,
  unit_price_cents: price,
  service_code: "wash",
  category_code: "coat",
});
const unavailable = (error: unknown) =>
  error instanceof HandlerCommandError && error.commandError.code === "RESOURCE_UNAVAILABLE";
const line = { service_code: "wash", category_code: "coat", qty: 1 };

test("selected catalog code captures the intended name and server price among aliases", async () => {
  const store = createMemoryCatalogStore([
    item("coat-a", "普通大衣"),
    item("coat-b", "羊绒大衣", 2500),
  ]);
  const result = await resolveServerPrices(
    store,
    requireLines([
      { ...line, catalog_code: "coat-b", unit_price_cents: 1, catalog_name: "伪造名称" },
    ]),
  );
  assert.equal(result[0]?.catalog_name, "羊绒大衣");
  assert.equal(result[0]?.catalog_code, "coat-b");
  assert.equal(result[0]?.unit_price_cents, 2500);
  for (const input of [
    { ...line, catalog_code: "not-active" },
    { ...line, service_code: "dry", catalog_code: "coat-b" },
    { ...line, category_code: "shirt", catalog_code: "coat-b" },
  ])
    await assert.rejects(resolveServerPrices(store, requireLines([input])), unavailable);
});

test("old equal-price alias input remains usable without inventing an item identity", async () => {
  const result = await resolveServerPrices(
    createMemoryCatalogStore([item("coat-a", "普通大衣"), item("coat-b", "羊绒大衣")]),
    requireLines([line]),
  );
  assert.equal(result[0]?.unit_price_cents, 1500);
  assert.equal(result[0]?.catalog_code, null);
  assert.equal(result[0]?.catalog_name, null);
});

test("legacy invalid catalog names fail with a controlled business error before persistence", async () => {
  for (const name of ["   ", "\t\n", "长".repeat(129)]) {
    await assert.rejects(
      resolveServerPrices(createMemoryCatalogStore([item("coat-a", name)]), requireLines([line])),
      unavailable,
    );
  }
  const result = await resolveServerPrices(
    createMemoryCatalogStore([item("coat-a", "  大衣  ")]),
    requireLines([line]),
  );
  assert.equal(result[0]?.catalog_name, "大衣");
});
