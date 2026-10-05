import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { garmentName } from "./garment-labels.js";
import { PickupResult } from "./PickupDetails.js";

test("historical labels use stable service and category without current catalog inference", () => {
  assert.equal(garmentName("dry", "shirt"), "干洗 · 衬衫");
  assert.equal(garmentName("wash", "coat"), "水洗 · 外套");
});

test("pickup result never presents internal garment UUIDs as clothing names", () => {
  const html = renderToStaticMarkup(
    createElement(PickupResult, {
      result: {
        order_id: "internal-order-id",
        ticket_no: "T-123",
        status: "completed",
        paid_cents: 1500,
        balance_cents: 0,
        picked_garment_ids: ["internal-garment-id"],
      },
    }),
  );
  assert.match(html, /衣物 1/u);
  assert.match(html, /已交付/u);
  assert.doesNotMatch(html, /internal-garment-id/u);
});
