import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  AUTHORITY_TEST_IDS,
  authoritySession,
  beginAuthorityAttempt,
  createAuthorityHarness,
  newDeviceKeys,
  signAuthorityRequest,
} from "./authority-test-fixture.js";

test("staff cannot create a first-pair challenge or insert an intent row", async () => {
  const harness = createAuthorityHarness();
  const attempt = await beginAuthorityAttempt(
    harness.service,
    authoritySession("staff"),
    newDeviceKeys(),
  );
  assert.equal(attempt, null);
  assert.equal(harness.store.debugSnapshot().challengeCount, 0);
  assert.equal(harness.store.debugSnapshot().deviceCount, 0);
});

test("admin pairing code succeeds once and is scoped to key, nonce, and challenge", async () => {
  const harness = createAuthorityHarness();
  const admin = authoritySession("admin");
  const keys = newDeviceKeys();
  const attempt = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(attempt);
  assert.equal(attempt.challenge.pairing_code, "123456");

  const wrongCode = signAuthorityRequest(
    attempt.challenge,
    attempt.challengeInput,
    keys.privateKey,
    { pairingCode: "654321" },
  );
  assert.equal(await harness.service.issue(admin, wrongCode), null);
  assert.equal(await harness.service.issue(admin, attempt.request), null);
  assert.equal(harness.store.debugSnapshot().deviceCount, 0);

  const success = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(success);
  const issued = await harness.service.issue(admin, success.request);
  assert.ok(issued);
  assert.equal(issued.primary_lease, null);
  assert.equal(issued.offline_grant.payload.request_nonce, success.challengeInput.request_nonce);
  assert.deepEqual(harness.store.debugSnapshot().auditEvents, ["edge.device.pair"]);
  assert.equal(await harness.service.issue(admin, success.request), null);
});

test("wrong nonce or public key cannot consume another challenge", async () => {
  const harness = createAuthorityHarness();
  const admin = authoritySession("admin");
  const keys = newDeviceKeys();
  const otherKeys = newDeviceKeys();
  const attempt = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(attempt);

  const wrongNonce = signAuthorityRequest(
    attempt.challenge,
    attempt.challengeInput,
    keys.privateKey,
    { requestNonce: randomUUID() },
  );
  assert.equal(await harness.service.issue(admin, wrongNonce), null);

  const otherSpki = otherKeys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const wrongKey = signAuthorityRequest(
    attempt.challenge,
    attempt.challengeInput,
    otherKeys.privateKey,
    { devicePublicKeySpki: otherSpki },
  );
  assert.equal(await harness.service.issue(admin, wrongKey), null);
  assert.notEqual(await harness.service.issue(admin, attempt.request), null);
});

test("pairing intent expires at 60 seconds and accepts at most one concurrent issue", async () => {
  const harness = createAuthorityHarness();
  const admin = authoritySession("admin");
  const keys = newDeviceKeys();
  const expired = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(expired);
  harness.advance(60_000);
  assert.equal(await harness.service.issue(admin, expired.request), null);

  const current = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(current);
  const results = await Promise.all([
    harness.service.issue(admin, current.request),
    harness.service.issue(admin, current.request),
  ]);
  assert.equal(results.filter((value) => value !== null).length, 1);
});

test("challenge replacement bounds rows and invalidates the replaced intent", async () => {
  const harness = createAuthorityHarness();
  const admin = authoritySession("admin");
  const keys = newDeviceKeys();
  const first = await beginAuthorityAttempt(harness.service, admin, keys);
  const second = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(first);
  assert.ok(second);
  assert.equal(harness.store.debugSnapshot().challengeCount, 1);
  assert.equal(await harness.service.issue(admin, first.request), null);
  assert.notEqual(await harness.service.issue(admin, second.request), null);
  assert.equal(harness.store.debugSnapshot().challengeCount, 1);
});

test("a paired same-key staff session can renew grant-only but cannot rotate the key", async () => {
  const harness = createAuthorityHarness();
  const admin = authoritySession("admin");
  const staff = authoritySession("staff");
  const keys = newDeviceKeys();
  const firstPair = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(firstPair);
  assert.notEqual(await harness.service.issue(admin, firstPair.request), null);

  const renewal = await beginAuthorityAttempt(harness.service, staff, keys);
  assert.ok(renewal);
  assert.equal(renewal.challenge.pairing_code, null);
  const renewed = await harness.service.issue(staff, renewal.request);
  assert.ok(renewed);
  assert.equal(renewed.primary_lease, null);
  assert.equal(await beginAuthorityAttempt(harness.service, staff, newDeviceKeys()), null);
  assert.equal(await beginAuthorityAttempt(harness.service, staff, keys, true), null);
  assert.equal(harness.store.debugSnapshot().deviceCount, 1);
  assert.equal(harness.store.debugSnapshot().pairedDeviceIds[0], AUTHORITY_TEST_IDS.deviceA);
});
