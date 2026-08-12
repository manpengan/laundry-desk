import assert from "node:assert/strict";
import test from "node:test";

import { initialArtifacts, syntheticRun } from "./adr36-web-journeys.mjs";
import { customerProfileJourneyContext } from "./adr42-customer-profile-support.mjs";

const CUSTOMER_ID = "22222222-2222-4222-8222-222222222201";
const ACCOUNT_ID = "33333333-3333-4333-8333-333333333301";

test("customer profile order context reads catalog codes from the synthetic run", () => {
  const run = syntheticRun(
    new Date("2026-08-09T12:34:56.000Z"),
    "00000000-0000-4000-8000-000000000001",
  );
  const artifacts = Object.freeze({
    ...initialArtifacts(),
    customerId: CUSTOMER_ID,
    customerPhone: "13800000001",
    memberAccountId: ACCOUNT_ID,
  });
  const noOp = () => {};
  const context = customerProfileJourneyContext({
    api: Object.freeze({
      command: noOp,
      confirm: noOp,
      expectCommandFailure: noOp,
      query: noOp,
      stepUp: noOp,
    }),
    adminSession: Object.freeze({ role: "admin" }),
    approverSession: Object.freeze({ role: "admin" }),
    approverPin: "850274",
    update: noOp,
    artifacts,
    run,
  });

  assert.equal(Object.hasOwn(artifacts, "serviceCode"), false);
  assert.equal(Object.hasOwn(artifacts, "categoryCode"), false);
  assert.deepEqual(context.orderRun, {
    label: run.label,
    note: run.note,
    serviceCode: run.serviceCode,
    categoryCode: run.categoryCode,
  });
});
