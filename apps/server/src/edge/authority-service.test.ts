import assert from "node:assert/strict";
import {
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import test from "node:test";

import {
  EdgeAuthorityRequestSchema,
  OFFLINE_GRANT_MAX_TTL_MS,
  canonicalizeEdgeDeviceRegistrationForSigning,
  canonicalizeForSignatureVerification,
  createOfflineGrantRegistrySnapshot,
  parseServerSignatureOfflineGrantCandidate,
  type EdgeAuthorityChallengeData,
  type EdgeAuthorityChallengeRequest,
  type EdgeAuthorityRequest,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { createEdgeAuthorityService } from "./authority-service.js";
import { createMemoryAuthorityStore } from "./memory-authority-store.js";

const ORG_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STORE_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "21a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const OTHER_DEVICE_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const SERVER_KEYS = generateKeyPairSync("ed25519");

function session(deviceId = DEVICE_ID): AuthorizedSession {
  return Object.freeze({
    session: Object.freeze({
      session_id: "b1a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      session_version: 1,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      device_id: deviceId,
      permission_version: 4,
      authentication_method: "password",
      status: "active",
      family_id: "c1a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      created_at: 1,
      revoked_at: null,
    }),
    authority: Object.freeze({
      staff_id: STAFF_ID,
      display_name: "Admin",
      role: "admin",
      permission_version: 4,
      is_privacy_admin: false,
    }),
  });
}

function authorityRequest(
  challenge: EdgeAuthorityChallengeData,
  challengeInput: EdgeAuthorityChallengeRequest,
  privateKey: KeyObject,
) {
  const authority = Object.freeze({
    protocol_version: "1.0.0",
    payload: Object.freeze({
      org_id: challenge.org_id,
      store_id: challenge.store_id,
      staff_id: challenge.staff_id,
      session_id: challenge.session_id,
      session_version: challenge.session_version,
      permission_version: challenge.permission_version,
      device_id: challenge.device_id,
      device_public_key_spki: challengeInput.device_public_key_spki,
      challenge_id: challenge.challenge_id,
      challenge: challenge.challenge,
      request_nonce: challengeInput.request_nonce,
      request_primary: challengeInput.request_primary,
      pairing_code: challenge.pairing_code,
    }),
  });
  return EdgeAuthorityRequestSchema.parse({
    ...authority,
    sig: sign(null, canonicalizeEdgeDeviceRegistrationForSigning(authority), privateKey).toString(
      "base64url",
    ),
  });
}

async function freshRequest(
  service: ReturnType<typeof createEdgeAuthorityService>,
  boundSession: AuthorizedSession,
  privateKey: KeyObject,
  publicKey: KeyObject,
) {
  const challengeInput = Object.freeze({
    request_nonce: randomUUID(),
    device_public_key_spki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    request_primary: true,
  });
  const challenge = await service.challenge(boundSession, challengeInput);
  assert.ok(challenge);
  return authorityRequest(challenge, challengeInput, privateKey);
}

test("persists proof-bound grants and serializes Primary lease takeover", async () => {
  let nowMs = Date.parse("2026-07-30T01:02:03.000Z");
  const service = createEdgeAuthorityService({
    store: createMemoryAuthorityStore({ now: () => new Date(nowMs) }),
    randomUUID,
    keyPair: SERVER_KEYS,
  });
  const deviceKeys = generateKeyPairSync("ed25519");
  const otherKeys = generateKeyPairSync("ed25519");
  const request = await freshRequest(
    service,
    session(),
    deviceKeys.privateKey,
    deviceKeys.publicKey,
  );

  const first = await service.issue(session(), request);
  assert.notEqual(first, null);
  if (first === null) return;
  assert.equal(first.offline_grant.payload.permission_version, 4);
  assert.deepEqual(first.offline_grant.payload.allowed_commands, [
    "order.receive",
    "order.hold",
    "customer.upsert",
    "print.ticket.enqueue",
    "print.ticket.retry",
    "print.ticket.reprint",
  ]);
  assert.equal(first.offline_grant.payload.ttl_ms, OFFLINE_GRANT_MAX_TTL_MS);
  assert.equal(
    Date.parse(first.offline_grant.payload.not_after) -
      Date.parse(first.offline_grant.payload.issued_at),
    OFFLINE_GRANT_MAX_TTL_MS,
  );
  assert.ok(first.primary_lease);
  assert.equal(first.primary_lease.payload.device_id, DEVICE_ID);
  assert.equal(first.primary_lease.payload.org_id, ORG_ID);
  assert.equal(first.primary_lease.payload.grant_id, first.offline_grant.payload.grant_id);
  assert.equal(first.primary_lease.payload.ttl_ms, 60_000);

  // Returning the old lease would let a fresh Edge process re-anchor the full
  // ttl at a later request and exceed the signed not_after.
  assert.equal(await service.issue(session(), request), null);

  const otherSession = session(OTHER_DEVICE_ID);
  const otherRequest = await freshRequest(
    service,
    otherSession,
    otherKeys.privateKey,
    otherKeys.publicKey,
  );
  assert.equal(await service.issue(session(OTHER_DEVICE_ID), otherRequest), null);

  const publicKey = createPublicKey({
    key: Buffer.from(first.server_public_key_spki, "base64"),
    format: "der",
    type: "spki",
  });
  const candidate = parseServerSignatureOfflineGrantCandidate(
    first.offline_grant,
    createOfflineGrantRegistrySnapshot(),
  );
  assert.equal(
    verify(
      null,
      canonicalizeForSignatureVerification(candidate),
      publicKey,
      Buffer.from(candidate.sig, "base64url"),
    ),
    true,
  );

  nowMs += 62_000;
  assert.equal(await service.issue(otherSession, otherRequest), null);
  const takeover = await service.issue(
    otherSession,
    await freshRequest(service, otherSession, otherKeys.privateKey, otherKeys.publicKey),
  );
  assert.notEqual(takeover, null);
  assert.equal(takeover?.primary_lease?.payload.primary_epoch, 2);
});

test("fails closed on invalid proof, session mismatch, and a changed bound public key", async () => {
  let nowMs = Date.parse("2026-07-30T01:02:03.000Z");
  const service = createEdgeAuthorityService({
    store: createMemoryAuthorityStore({ now: () => new Date(nowMs) }),
    randomUUID,
    keyPair: SERVER_KEYS,
  });
  const original = generateKeyPairSync("ed25519");
  const replacement = generateKeyPairSync("ed25519");
  const request = await freshRequest(service, session(), original.privateKey, original.publicKey);
  const badProof = Object.freeze({ ...request, sig: "A".repeat(86) }) as EdgeAuthorityRequest;

  assert.equal(await service.issue(session(), badProof), null);
  assert.equal(await service.issue(session(OTHER_DEVICE_ID), request), null);
  assert.notEqual(await service.issue(session(), request), null);

  nowMs += 62_000;
  const replacementChallenge = await service.challenge(session(), {
    request_nonce: randomUUID(),
    device_public_key_spki: replacement.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    request_primary: true,
  });
  assert.equal(replacementChallenge, null);
  assert.notEqual(
    await service.issue(
      session(),
      await freshRequest(service, session(), original.privateKey, original.publicKey),
    ),
    null,
  );
});

test("expires challenges and atomically accepts at most one concurrent proof", async () => {
  let nowMs = Date.parse("2026-07-30T01:02:03.000Z");
  const service = createEdgeAuthorityService({
    store: createMemoryAuthorityStore({ now: () => new Date(nowMs) }),
    randomUUID,
    keyPair: SERVER_KEYS,
  });
  const keys = generateKeyPairSync("ed25519");
  const expired = await freshRequest(service, session(), keys.privateKey, keys.publicKey);
  nowMs += 60_000;
  assert.equal(await service.issue(session(), expired), null);

  const request = await freshRequest(service, session(), keys.privateKey, keys.publicKey);
  const results = await Promise.all([
    service.issue(session(), request),
    service.issue(session(), request),
  ]);
  assert.equal(results.filter((result) => result !== null).length, 1);
});

test("rejects invalid authority timing and mismatched server signing keys", () => {
  assert.throws(
    () =>
      createEdgeAuthorityService({
        store: createMemoryAuthorityStore(),
        randomUUID,
        keyPair: SERVER_KEYS,
        leaseTtlMs: 0,
      }),
    /leaseTtlMs/u,
  );
  assert.throws(
    () =>
      createEdgeAuthorityService({
        store: createMemoryAuthorityStore(),
        randomUUID,
        keyPair: Object.freeze({
          publicKey: generateKeyPairSync("ed25519").publicKey,
          privateKey: generateKeyPairSync("ed25519").privateKey,
        }),
      }),
    /do not match/u,
  );
});
