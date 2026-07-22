import assert from "node:assert/strict";
import test from "node:test";

import { createMockAuthClient } from "./AuthClient.js";

test("mock step-up challenge + verify issues proof without session switch", async () => {
  const client = createMockAuthClient();
  await client.login({
    org_code: "hongfa",
    store_code: "main",
    username: "admin",
    password: "demo",
  });
  const challenge = await client.createPinChallenge({
    purpose: "step_up",
    pending_action_ref: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    approver_staff_id: "11111111-1111-4111-8111-111111111101",
  });
  assert.equal(challenge.ok, true);
  if (!challenge.ok) return;
  assert.equal(challenge.data.purpose, "step_up");

  const proof = await client.verifyStepUpPin({
    challenge_id: challenge.data.challenge_id,
    pin: "1234",
  });
  assert.equal(proof.ok, true);
  if (!proof.ok) return;
  assert.match(proof.data.step_up_proof_id, /^[0-9a-f-]+$/iu);
  assert.ok(proof.data.expires_at > 0);
});

test("mock verifyPin rejects step_up challenge id", async () => {
  const client = createMockAuthClient();
  const challenge = await client.createPinChallenge({
    purpose: "step_up",
    pending_action_ref: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    approver_staff_id: "11111111-1111-4111-8111-111111111102",
  });
  assert.equal(challenge.ok, true);
  if (!challenge.ok) return;
  const wrong = await client.verifyPin({
    challenge_id: challenge.data.challenge_id,
    pin: "1234",
  });
  assert.equal(wrong.ok, false);
});
