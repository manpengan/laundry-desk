import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORITY_TEST_IDS,
  authoritySession,
  beginAuthorityAttempt,
  createAuthorityHarness,
  newDeviceKeys,
} from "./authority-test-fixture.js";

async function pairGrantOnly(
  harness: ReturnType<typeof createAuthorityHarness>,
  deviceId: string,
  keys: ReturnType<typeof newDeviceKeys>,
): Promise<void> {
  const admin = authoritySession("admin", deviceId);
  const attempt = await beginAuthorityAttempt(harness.service, admin, keys);
  assert.ok(attempt);
  const result = await harness.service.issue(admin, attempt.request);
  assert.ok(result);
  assert.equal(result.primary_lease, null);
}

test("Primary is absent by default and a fresh admin intent can promote", async () => {
  const harness = createAuthorityHarness();
  const keys = newDeviceKeys();
  const admin = authoritySession("admin");
  await pairGrantOnly(harness, AUTHORITY_TEST_IDS.deviceA, keys);

  const promotion = await beginAuthorityAttempt(harness.service, admin, keys, true);
  assert.ok(promotion);
  assert.equal(promotion.challenge.pairing_code, null);
  const issued = await harness.service.issue(admin, promotion.request);
  assert.ok(issued);
  assert.equal(issued.primary_lease?.payload.primary_epoch, 1);
  assert.equal(issued.primary_lease?.payload.grant_id, issued.offline_grant.payload.grant_id);
  assert.deepEqual(harness.store.debugSnapshot().auditEvents, [
    "edge.device.pair",
    "edge.primary.promote",
  ]);
});

test("captured head epoch rejects stale concurrent promotion intents", async () => {
  const harness = createAuthorityHarness();
  const keysA = newDeviceKeys();
  const keysB = newDeviceKeys();
  await pairGrantOnly(harness, AUTHORITY_TEST_IDS.deviceA, keysA);
  await pairGrantOnly(harness, AUTHORITY_TEST_IDS.deviceB, keysB);
  const adminA = authoritySession("admin", AUTHORITY_TEST_IDS.deviceA);
  const adminB = authoritySession("admin", AUTHORITY_TEST_IDS.deviceB);
  const intentA = await beginAuthorityAttempt(harness.service, adminA, keysA, true);
  const intentB = await beginAuthorityAttempt(harness.service, adminB, keysB, true);
  assert.ok(intentA);
  assert.ok(intentB);

  const [issuedA, issuedB] = await Promise.all([
    harness.service.issue(adminA, intentA.request),
    harness.service.issue(adminB, intentB.request),
  ]);
  assert.equal([issuedA, issuedB].filter((value) => value !== null).length, 1);
  assert.equal(harness.store.debugSnapshot().leaseCount, 1);
});

test("old lease blocks promotion until not_after plus skew, with a new intent required", async () => {
  const harness = createAuthorityHarness();
  const keysA = newDeviceKeys();
  const keysB = newDeviceKeys();
  await pairGrantOnly(harness, AUTHORITY_TEST_IDS.deviceA, keysA);
  await pairGrantOnly(harness, AUTHORITY_TEST_IDS.deviceB, keysB);
  const adminA = authoritySession("admin", AUTHORITY_TEST_IDS.deviceA);
  const adminB = authoritySession("admin", AUTHORITY_TEST_IDS.deviceB);
  const first = await beginAuthorityAttempt(harness.service, adminA, keysA, true);
  assert.ok(first);
  assert.notEqual(await harness.service.issue(adminA, first.request), null);

  const blocked = await beginAuthorityAttempt(harness.service, adminB, keysB, true);
  assert.ok(blocked);
  assert.equal(await harness.service.issue(adminB, blocked.request), null);
  harness.advance(62_000);
  assert.equal(await harness.service.issue(adminB, blocked.request), null);

  const eligible = await beginAuthorityAttempt(harness.service, adminB, keysB, true);
  assert.ok(eligible);
  const promoted = await harness.service.issue(adminB, eligible.request);
  assert.equal(promoted?.primary_lease?.payload.primary_epoch, 2);
});

test("expired, reused, refresh-authenticated, and staff promotion intents fail closed", async () => {
  const harness = createAuthorityHarness();
  const keys = newDeviceKeys();
  await pairGrantOnly(harness, AUTHORITY_TEST_IDS.deviceA, keys);
  const admin = authoritySession("admin");
  const expired = await beginAuthorityAttempt(harness.service, admin, keys, true);
  assert.ok(expired);
  harness.advance(60_000);
  assert.equal(await harness.service.issue(admin, expired.request), null);

  assert.equal(
    await beginAuthorityAttempt(
      harness.service,
      authoritySession("admin", AUTHORITY_TEST_IDS.deviceA, "refresh"),
      keys,
      true,
    ),
    null,
  );
  assert.equal(
    await beginAuthorityAttempt(harness.service, authoritySession("staff"), keys, true),
    null,
  );
});
