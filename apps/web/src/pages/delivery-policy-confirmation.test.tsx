import assert from "node:assert/strict";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { DeliveryPolicyConfirmationSummaryView } from "./DeliveryPolicyConfirmationSummary.js";

test("delivery policy confirmation renders the complete immutable R5 authority", () => {
  const html = renderToStaticMarkup(
    <DeliveryPolicyConfirmationSummaryView
      summary={{
        kind: "delivery_policy",
        expected_version: 7,
        accepting_appointments: true,
        minimum_lead_minutes: 180,
        maximum_advance_days: 21,
        slot_minutes: 30,
        max_appointments_per_slot: 4,
        service_areas: [{ code: "north", name: "北区", fee_cents: 1_200, is_active: true }],
        weekly_windows: [{ weekday: 2, start_minute: 540, end_minute: 1_020 }],
      }}
    />,
  );

  for (const expected of [
    "版本 7",
    "180",
    "21",
    "30",
    "4",
    "north",
    "北区",
    "¥12.00",
    "09:00",
    "17:00",
  ]) {
    assert.match(html, new RegExp(expected, "u"));
  }
});
