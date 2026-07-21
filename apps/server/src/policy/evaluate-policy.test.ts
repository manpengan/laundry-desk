import assert from "node:assert/strict";
import test from "node:test";

import type { RiskLevel } from "@laundry/domain";

import { checkPolicy, evaluatePolicy } from "./evaluate-policy.js";
import type { EvaluatePolicyInput, PolicyActor } from "./types.js";

const STAFF = "11111111-1111-4111-8111-111111111111";

const actor = (via: PolicyActor["via"], extras: Partial<PolicyActor> = {}): PolicyActor =>
  Object.freeze({
    staffId: STAFF,
    via,
    permissions: extras.permissions ?? Object.freeze(["orders.write"]),
    ...(extras.riskCap !== undefined ? { riskCap: extras.riskCap } : {}),
    ...(extras.staffId !== undefined ? { staffId: extras.staffId } : {}),
  });

const inputFor = (
  baseRisk: RiskLevel,
  via: PolicyActor["via"] = "ui",
  extras: Partial<EvaluatePolicyInput> = {},
): EvaluatePolicyInput =>
  Object.freeze({
    actor: extras.actor ?? actor(via),
    command:
      extras.command ??
      Object.freeze({
        name: "demo.command",
        baseRisk,
        requiredPermission: "orders.write",
      }),
    ...(extras.riskInput !== undefined ? { riskInput: extras.riskInput } : {}),
  });

test("R0 / R1 / R2 allow for ui", () => {
  for (const risk of ["R0", "R1", "R2"] as const) {
    const decision = evaluatePolicy(inputFor(risk, "ui"));
    assert.equal(decision.outcome, "allow");
    assert.equal(decision.effectiveRisk, risk);
    assert.equal(decision.escalated, false);
  }
});

test("R3 confirm for ui and ai", () => {
  const ui = evaluatePolicy(inputFor("R3", "ui"));
  assert.equal(ui.outcome, "confirm");
  if (ui.outcome === "confirm") {
    assert.equal(ui.requiresOtherApprover, false);
  }

  const ai = evaluatePolicy(inputFor("R3", "ai", { actor: actor("ai", { riskCap: "R3" }) }));
  assert.equal(ai.outcome, "confirm");
});

test("R4 step_up for ui; requires other approver", () => {
  const decision = evaluatePolicy(inputFor("R4", "ui"));
  assert.equal(decision.outcome, "step_up");
  if (decision.outcome === "step_up") {
    assert.equal(decision.requiresOtherApprover, true);
  }
});

test("R5 step_up for ui; deny for ai", () => {
  const ui = evaluatePolicy(inputFor("R5", "ui"));
  assert.equal(ui.outcome, "step_up");

  const ai = evaluatePolicy(inputFor("R5", "ai", { actor: actor("ai", { riskCap: "R5" }) }));
  assert.equal(ai.outcome, "deny");
  if (ai.outcome === "deny") {
    assert.equal(ai.reason, "ai_r5_forbidden");
  }
});

test("R4/R5 denied for automation and edge_replay", () => {
  for (const risk of ["R4", "R5"] as const) {
    for (const via of ["automation", "edge_replay"] as const) {
      const decision = evaluatePolicy(inputFor(risk, via));
      assert.equal(decision.outcome, "deny", `${via}/${risk}`);
    }
  }
});

test("missing permission denies", () => {
  const decision = evaluatePolicy(
    inputFor("R0", "ui", {
      actor: actor("ui", { permissions: Object.freeze([]) }),
    }),
  );
  assert.equal(decision.outcome, "deny");
  if (decision.outcome === "deny") {
    assert.equal(decision.reason, "missing_permission");
  }
});

test("AI risk_cap blocks higher effective risk", () => {
  const decision = evaluatePolicy(inputFor("R3", "ai", { actor: actor("ai", { riskCap: "R2" }) }));
  assert.equal(decision.outcome, "deny");
  if (decision.outcome === "deny") {
    assert.equal(decision.reason, "risk_cap_exceeded");
  }
});

test("B4 escalation R3→R4 yields step_up", () => {
  const decision = evaluatePolicy(
    inputFor("R3", "ui", {
      riskInput: {
        measures: { batch: 50 },
        factoryLimits: { risk_escalation: { max_batch: 20 } },
      },
    }),
  );
  assert.equal(decision.outcome, "step_up");
  assert.equal(decision.effectiveRisk, "R4");
  assert.equal(decision.escalated, true);
});

test("B4 hard limit becomes deny", () => {
  const decision = evaluatePolicy(
    inputFor("R3", "ui", {
      riskInput: {
        measures: { batch: 200 },
        factoryLimits: { hard_limits: { max_batch: 100 } },
      },
    }),
  );
  assert.equal(decision.outcome, "deny");
  if (decision.outcome === "deny") {
    assert.equal(decision.reason, "hard_limit_exceeded");
  }
});

test("checkPolicy maps deny to port failure and allow/confirm/step_up to success", () => {
  const allowed = checkPolicy(inputFor("R0", "ui"));
  assert.equal(allowed.ok, true);
  if (allowed.ok) assert.equal(allowed.data.outcome, "allow");

  const confirmed = checkPolicy(inputFor("R3", "ui"));
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) assert.equal(confirmed.data.outcome, "confirm");

  const stepped = checkPolicy(inputFor("R4", "ui"));
  assert.equal(stepped.ok, true);
  if (stepped.ok) assert.equal(stepped.data.outcome, "step_up");

  const denied = checkPolicy(inputFor("R5", "ai", { actor: actor("ai", { riskCap: "R5" }) }));
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    assert.equal(denied.error.code, "POLICY_DENIED");
    assert.equal(denied.error.reason, "ai_r5_forbidden");
  }
});
