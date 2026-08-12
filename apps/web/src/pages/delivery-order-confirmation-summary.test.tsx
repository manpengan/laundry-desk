import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DeliveryOrderPendingSummary } from "./DeliveryOrderDetailPanel.js";
import type { DeliveryOrderPendingTransition } from "./delivery-order-model.js";

test("R3 confirmation renders the complete immutable order and route summary", () => {
  const pending: DeliveryOrderPendingTransition = Object.freeze({
    body: Object.freeze({
      delivery_order_id: "11111111-1111-4111-8111-111111111111",
      customer_id: "22222222-2222-4222-8222-222222222222",
      expected_version: 7,
      target_status: "cancelled",
      cancellation_reason: "store_request",
    }),
    authorityKey: "frozen-authority",
    confirmRef: "33333333-3333-4333-8333-333333333333",
    kind: "step_up",
    label: "已取消",
    summary: Object.freeze({
      deliveryOrderId: "11111111-1111-4111-8111-111111111111",
      laundryOrderId: "44444444-4444-4444-8444-444444444444",
      currentStatus: "pickup_scheduled",
      collectionMethod: "pickup",
      returnMethod: "delivery",
      cancellationReason: "store_request",
    }),
  });
  const html = renderToStaticMarkup(<DeliveryOrderPendingSummary pending={pending} />);
  assert.match(html, /11111111-1111-4111-8111-111111111111/u);
  assert.match(html, /44444444-4444-4444-8444-444444444444/u);
  assert.match(html, /上门取件/u);
  assert.match(html, /送回到家/u);
  assert.match(html, /版本 7/u);
  assert.match(html, /门店要求取消/u);
});
