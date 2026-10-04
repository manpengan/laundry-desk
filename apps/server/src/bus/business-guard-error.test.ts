import assert from "node:assert/strict";
import test from "node:test";
import { businessGuardError } from "./business-guard-error.js";

const pgError = (message: string, code = "23514") => Object.assign(new Error(message), { code });

test("unfinished channel money maps to an actionable payment_pending reason", () => {
  for (const message of ["CHANNEL_PAYMENT_PENDING", "CHANNEL_REFUND_PENDING"]) {
    assert.deepEqual(businessGuardError(pgError(message)), {
      code: "RESOURCE_UNAVAILABLE",
      message: "Resource is unavailable",
      detail: { kind: "reason", reason: "payment_pending" },
    });
  }
  const wrapped = new Error("transaction aborted", { cause: pgError("CHANNEL_PAYMENT_PENDING") });
  assert.equal(businessGuardError(wrapped)?.code, "RESOURCE_UNAVAILABLE");
});

test("manual refunds of provider money point to the provider refund", () => {
  const error = businessGuardError(pgError("CHANNEL_REFUND_REQUIRED"));
  assert.ok(error !== null && "detail" in error);
  assert.equal(error.code, "POLICY_DENIED");
  assert.deepEqual(error.detail, { kind: "reason", reason: "channel_refund_required" });
});

test("other failures stay unexpected", () => {
  assert.equal(businessGuardError(pgError("CHANNEL_PAYMENT_PENDING", "40001")), null);
  assert.equal(businessGuardError(pgError("SOMETHING_ELSE")), null);
  assert.equal(businessGuardError("CHANNEL_PAYMENT_PENDING"), null);
  assert.equal(businessGuardError(null), null);
});
