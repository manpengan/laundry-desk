import assert from "node:assert/strict";
import test from "node:test";

import { createLoginIntentGate } from "./auth-intent.js";

test("a later valid login wins regardless of validation completion order", () => {
  const laterFirst = createLoginIntentGate();
  const earlierA = laterFirst.beginLogin();
  const laterA = laterFirst.beginLogin();
  assert.equal(laterFirst.registerValidLogin(laterA), true);
  assert.equal(laterFirst.registerValidLogin(earlierA), false);

  const earlierFirst = createLoginIntentGate();
  const earlierB = earlierFirst.beginLogin();
  const laterB = earlierFirst.beginLogin();
  assert.equal(earlierFirst.registerValidLogin(earlierB), true);
  assert.equal(earlierFirst.registerValidLogin(laterB), true);
});

test("an invalid later login does not supersede an earlier valid login", () => {
  const gate = createLoginIntentGate();
  const earlier = gate.beginLogin();
  gate.beginLogin();

  assert.equal(gate.registerValidLogin(earlier), true);
});

test("logout cancels earlier validation without cancelling a later login", () => {
  const gate = createLoginIntentGate();
  const beforeLogout = gate.beginLogin();
  gate.cancelPendingLogins();
  const afterLogout = gate.beginLogin();

  assert.equal(gate.registerValidLogin(beforeLogout), false);
  assert.equal(gate.registerValidLogin(afterLogout), true);
});

test("unknown or repeated invocations fail closed", () => {
  const gate = createLoginIntentGate();
  const invocation = gate.beginLogin();

  assert.equal(gate.registerValidLogin(0), false);
  assert.equal(gate.registerValidLogin(invocation + 1), false);
  assert.equal(gate.registerValidLogin(invocation), true);
  assert.equal(gate.registerValidLogin(invocation), false);
});
