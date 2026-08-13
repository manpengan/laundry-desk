import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { readConfirmationSummary } from "../commands/confirmation-summary.js";
import { DeliveryTaskPendingSummary } from "./DeliveryTaskPendingSummary.js";

test("browser parser and WYSIWYS UI preserve the server-owned task snapshot", () => {
  const summary = readConfirmationSummary({
    kind: "delivery_task_operation",
    operation: "takeover",
    delivery_order_id: "11111111-1111-4111-8111-111111111111",
    delivery_order_version: 7,
    leg: "return",
    delivery_task_id: "22222222-2222-4222-8222-222222222222",
    delivery_task_version: 3,
    current_status: "accepted",
    from_assignee_staff_id: "33333333-3333-4333-8333-333333333333",
    to_assignee_staff_id: "44444444-4444-4444-8444-444444444444",
    decision: null,
    resolution_reason: "emergency",
  });
  assert.ok(summary);
  assert.equal(summary.kind, "delivery_task_operation");
  if (summary.kind !== "delivery_task_operation") return;
  const html = renderToStaticMarkup(<DeliveryTaskPendingSummary summary={summary} />);
  assert.match(html, /人工接管/u);
  assert.match(html, /送回到家/u);
  assert.match(html, /v7/u);
  assert.match(html, /v3/u);
  assert.match(html, /33333333-3333-4333-8333-333333333333/u);
  assert.match(html, /44444444-4444-4444-8444-444444444444/u);
  assert.match(html, /紧急接管/u);
});

test("browser rejects partial or augmented task confirmation summaries", () => {
  assert.equal(readConfirmationSummary({ kind: "delivery_task_operation" }), null);
  assert.equal(
    readConfirmationSummary({
      kind: "delivery_task_operation",
      operation: "assign",
      delivery_order_id: "11111111-1111-4111-8111-111111111111",
      delivery_order_version: 1,
      leg: "pickup",
      delivery_task_id: null,
      delivery_task_version: null,
      current_status: null,
      from_assignee_staff_id: null,
      to_assignee_staff_id: "22222222-2222-4222-8222-222222222222",
      decision: null,
      resolution_reason: null,
      gps: [1, 2],
    }),
    null,
  );
});
