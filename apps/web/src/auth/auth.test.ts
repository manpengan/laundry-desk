import assert from "node:assert/strict";
import test from "node:test";
import { createMockAuthClient } from "./AuthClient.js";
import { setDeviceIdForTests } from "./device-id.js";
import { assertNoAuthSecretsInWebStorage, webStorageHasAuthSecrets } from "./storage-guard.js";
import { hasLoginFieldErrors, validateLoginForm } from "./validate-login.js";
import { validatePin } from "./validate-pin.js";

const DEVICE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("validateLoginForm rejects empty fields", () => {
  const errors = validateLoginForm({
    org_code: "",
    store_code: "",
    username: "",
    password: "",
  });
  assert.equal(hasLoginFieldErrors(errors), true);
  assert.ok(errors.org_code);
  assert.ok(errors.store_code);
  assert.ok(errors.username);
  assert.ok(errors.password);
});

test("validateLoginForm accepts filled fields", () => {
  const errors = validateLoginForm({
    org_code: "org1",
    store_code: "store1",
    username: "clerk",
    password: "demo",
  });
  assert.equal(hasLoginFieldErrors(errors), false);
});

test("validatePin enforces 4-8 digits", () => {
  assert.ok(validatePin(""));
  assert.ok(validatePin("12"));
  assert.ok(validatePin("abcdef"));
  assert.equal(validatePin("1234"), null);
  assert.equal(validatePin("12345678"), null);
});

test("mock login success returns memory_only session and no web storage write", async () => {
  setDeviceIdForTests(DEVICE);
  const client = createMockAuthClient({ validPassword: "demo" });
  const result = await client.login({
    org_code: "ORG",
    store_code: "S1",
    username: "clerk",
    password: "demo",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.storage, "memory_only");
  assert.equal(result.data.token_type, "Bearer");
  assert.ok(result.data.access_token.includes("."));
  assert.equal(result.data.session.device_id, DEVICE);
  assertNoAuthSecretsInWebStorage();
  assert.equal(webStorageHasAuthSecrets(), false);
});

test("mock login failure does not return a token", async () => {
  setDeviceIdForTests(DEVICE);
  const client = createMockAuthClient({ validPassword: "demo" });
  const result = await client.login({
    org_code: "ORG",
    store_code: "S1",
    username: "clerk",
    password: "wrong",
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "AUTHENTICATION_FAILED");
  assertNoAuthSecretsInWebStorage();
});

test("PIN challenge + verify switches staff without web storage", async () => {
  setDeviceIdForTests(DEVICE);
  const client = createMockAuthClient({ validPassword: "demo", validPin: "1234" });
  const login = await client.login({
    org_code: "ORG",
    store_code: "S1",
    username: "clerk",
    password: "demo",
  });
  assert.equal(login.ok, true);
  if (!login.ok) return;

  const target = client
    .listSwitchableStaff()
    .find((s) => s.staff_id !== login.data.session.staff_id);
  assert.ok(target);

  const challenge = await client.createPinChallenge({
    purpose: "quick_switch",
    target_staff_id: target.staff_id,
  });
  assert.equal(challenge.ok, true);
  if (!challenge.ok) return;

  const verified = await client.verifyPin({
    challenge_id: challenge.data.challenge_id,
    pin: "1234",
  });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.data.session.staff_id, target.staff_id);
  assert.equal(verified.data.display.staff_name, target.display_name);
  assert.equal(verified.data.storage, "memory_only");
  assertNoAuthSecretsInWebStorage();
});

test("wrong PIN fails and leaves no token in storage", async () => {
  setDeviceIdForTests(DEVICE);
  const client = createMockAuthClient({ validPin: "1234" });
  await client.login({
    org_code: "ORG",
    store_code: "S1",
    username: "clerk",
    password: "demo",
  });
  const target = client.listSwitchableStaff()[1];
  assert.ok(target);
  const challenge = await client.createPinChallenge({
    purpose: "quick_switch",
    target_staff_id: target.staff_id,
  });
  assert.equal(challenge.ok, true);
  if (!challenge.ok) return;
  const verified = await client.verifyPin({
    challenge_id: challenge.data.challenge_id,
    pin: "0000",
  });
  assert.equal(verified.ok, false);
  assertNoAuthSecretsInWebStorage();
});
