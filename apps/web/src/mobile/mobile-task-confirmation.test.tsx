import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MobileTaskTransitionSummary } from "./MobileTaskCards.js";
import type { MobileTaskPendingAction } from "./use-mobile-task-mutations.js";

test("mobile order confirmation renders complete immutable task and route authority", () => {
  const pending: Extract<MobileTaskPendingAction, { kind: "transition" }> = Object.freeze({
    kind: "transition",
    confirmRef: "11111111-1111-4111-8111-111111111111",
    body: Object.freeze({
      delivery_order_id: "22222222-2222-4222-8222-222222222222",
      customer_id: "33333333-3333-4333-8333-333333333333",
      expected_version: 7,
      target_status: "return_in_progress",
    }),
    action: Object.freeze({
      targetStatus: "return_in_progress",
      label: "开始送回",
      hint: "仅记录状态",
    }),
    authority: Object.freeze({
      deliveryTaskId: "44444444-4444-4444-8444-444444444444",
      deliveryTaskVersion: 3,
      taskStatus: "accepted",
      leg: "return",
      deliveryOrderId: "22222222-2222-4222-8222-222222222222",
      laundryOrderId: "55555555-5555-4555-8555-555555555555",
      deliveryOrderVersion: 7,
      currentStatus: "return_scheduled",
      targetStatus: "return_in_progress",
      collectionMethod: "pickup",
      returnMethod: "delivery",
      cancellationReason: null,
      taskSnapshotKey: "strict-task-snapshot",
      orderSnapshotKey: "strict-order-snapshot",
    }),
    authorityKey: "frozen-session-task-order-route-authority",
    snapshot: Object.freeze({
      scope: "session-store-staff",
      taskId: "44444444-4444-4444-8444-444444444444",
      taskVersion: 3,
      taskStatus: "accepted",
      orderId: "22222222-2222-4222-8222-222222222222",
      orderVersion: 7,
    }),
  });

  const html = renderToStaticMarkup(<MobileTaskTransitionSummary pending={pending} />);

  assert.match(html, /44444444-4444-4444-8444-444444444444/u);
  assert.match(html, /22222222-2222-4222-8222-222222222222/u);
  assert.match(html, /55555555-5555-4555-8555-555555555555/u);
  assert.match(html, /送回到家/u);
  assert.match(html, /待送回/u);
  assert.match(html, /送回途中/u);
  assert.match(html, /v3/u);
  assert.match(html, /v7/u);
  assert.doesNotMatch(html, /33333333-3333-4333-8333-333333333333/u);
});
