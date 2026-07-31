import assert from "node:assert/strict";
import { verify } from "node:crypto";
import test from "node:test";

import {
  EdgeAuthorityRequestSchema,
  EdgeReplayRequestSchema,
  canonicalizeEdgeDeviceRegistrationForSigning,
  canonicalizeEdgeReplayForSigning,
  createCommandError,
  parseEdgeQueueEnvelope,
  type EdgeAuthorityResponse,
} from "@laundry/contracts";

import { MemoryDeviceKeyStore } from "../pairing/device-keys.js";
import { createEdgeAuthorityRequester } from "./edge-authority-transport.js";
import {
  createSignedAuthorityRequest,
  createSignedReplayRequest,
  projectReplayResponse,
  requestFreshEdgeAuthority,
} from "./edge-http.js";

const DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_NONCE = "00000000-0000-4000-8000-000000000008";
const STALE_REQUEST_NONCE = "00000000-0000-4000-8000-000000000009";
const authorityChallenge = Object.freeze({
  org_id: "00000000-0000-4000-8000-000000000002",
  store_id: "00000000-0000-4000-8000-000000000003",
  staff_id: "00000000-0000-4000-8000-000000000004",
  session_id: "00000000-0000-4000-8000-000000000005",
  session_version: 1,
  permission_version: 2,
  device_id: DEVICE_ID,
  challenge_id: "00000000-0000-4000-8000-000000000006",
  challenge: "A".repeat(43),
  request_nonce: REQUEST_NONCE,
  pairing_code: "123456",
  expires_at: "2026-07-30T01:02:33.000Z",
});

function authorityResponse(requestNonce: string): EdgeAuthorityResponse {
  return Object.freeze({
    ok: true,
    data: Object.freeze({
      server_public_key_spki: "AQ==",
      offline_grant: Object.freeze({
        protocol_version: "1.0.0",
        payload: Object.freeze({
          grant_id: "00000000-0000-4000-8000-000000000010",
          org_id: authorityChallenge.org_id,
          store_id: authorityChallenge.store_id,
          staff_id: authorityChallenge.staff_id,
          device_id: DEVICE_ID,
          request_nonce: requestNonce,
          permission_version: authorityChallenge.permission_version,
          allowed_commands: Object.freeze(["order.pickup"]),
          issued_at: "2026-07-30T01:02:03.000Z",
          ttl_ms: 30_000,
          not_after: "2026-07-30T01:02:33.000Z",
        }),
        sig: "A".repeat(86),
      }),
      primary_lease: null,
    }),
  });
}

function envelope() {
  return parseEdgeQueueEnvelope({
    queue_envelope_version: 1,
    contracts_major: 0,
    queue_id: "32ff7821-0b72-4f9c-8ec6-8d7e08500e04",
    enqueued_at: "2026-07-30T01:02:03.000Z",
    payload: {
      command: "order.pickup",
      version: "1.0.0",
      mode: "direct",
      args: { order_id: "936da01f-9abd-4d9d-80c7-02af85c822a8" },
      idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
      dry_run: false,
    },
    authorization: {
      kind: "primary_lease",
      grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
      lease_id: "e87a5f8a-e4d3-4404-b9c2-40cdf899e8d1",
      primary_epoch: 1,
      per_lease_seq: 1,
    },
  });
}

test("authority and replay helpers sign separate complete device authorities", () => {
  const material = new MemoryDeviceKeyStore().generate();
  const signer = Object.freeze({
    publicKeySpkiBase64Url: material.exportPublic().publicKeySpkiBase64Url,
    signBytes: (message: Uint8Array) => material.signBytes(message),
  });
  const authority = EdgeAuthorityRequestSchema.parse(
    createSignedAuthorityRequest(DEVICE_ID, authorityChallenge, signer, REQUEST_NONCE, true),
  );
  const replay = EdgeReplayRequestSchema.parse(
    createSignedReplayRequest(DEVICE_ID, envelope(), signer),
  );

  assert.equal(
    verify(
      null,
      canonicalizeEdgeDeviceRegistrationForSigning({
        protocol_version: authority.protocol_version,
        payload: authority.payload,
      }),
      material.publicKey,
      Buffer.from(authority.sig, "base64url"),
    ),
    true,
  );
  assert.equal(authority.payload.request_nonce, REQUEST_NONCE);
  assert.equal(authority.payload.request_primary, true);
  assert.equal(authority.payload.pairing_code, "123456");
  assert.equal(
    verify(
      null,
      canonicalizeEdgeReplayForSigning({
        protocol_version: replay.protocol_version,
        payload: replay.payload,
      }),
      material.publicKey,
      Buffer.from(replay.sig, "base64url"),
    ),
    true,
  );
});

test("authority signing rejects a stale challenge request nonce", () => {
  const material = new MemoryDeviceKeyStore().generate();
  const signer = Object.freeze({
    publicKeySpkiBase64Url: material.exportPublic().publicKeySpkiBase64Url,
    signBytes: (message: Uint8Array) => material.signBytes(message),
  });

  assert.throws(
    () =>
      createSignedAuthorityRequest(
        DEVICE_ID,
        authorityChallenge,
        signer,
        STALE_REQUEST_NONCE,
        true,
      ),
    /request nonce mismatch/u,
  );
});

test("replay response projection never exposes the outer protocol wrapper", () => {
  assert.deepEqual(
    projectReplayResponse({
      ok: true,
      data: {
        disposition: "applied",
        command: { ok: true, data: { execution: "executed", result: { picked_up: true } } },
      },
    }),
    { ok: true, data: { execution: "executed", result: { picked_up: true } } },
  );
});

test("an authentication refresh obtains and signs a fresh authority challenge", async () => {
  const material = new MemoryDeviceKeyStore().generate();
  const signer = Object.freeze({
    publicKeySpkiBase64Url: material.exportPublic().publicKeySpkiBase64Url,
    signBytes: (message: Uint8Array) => material.signBytes(message),
  });
  const challenges = [
    authorityChallenge,
    {
      ...authorityChallenge,
      challenge_id: "00000000-0000-4000-8000-000000000007",
      challenge: "B".repeat(43),
    },
  ];
  const issued: ReturnType<typeof createSignedAuthorityRequest>[] = [];
  let refreshes = 0;
  const result = await requestFreshEdgeAuthority(
    DEVICE_ID,
    signer,
    REQUEST_NONCE,
    true,
    async () => ({ ok: true, data: challenges.shift()! }),
    async (request) => {
      issued.push(request);
      return {
        ok: false,
        error: createCommandError(
          issued.length === 1 ? "AUTHENTICATION_FAILED" : "RESOURCE_UNAVAILABLE",
        ),
      };
    },
    async () => {
      refreshes += 1;
      return true;
    },
  );

  assert.equal(result.ok, false);
  assert.equal(refreshes, 1);
  assert.equal(issued.length, 2);
  assert.notEqual(issued[0]?.payload.challenge_id, issued[1]?.payload.challenge_id);
  assert.notEqual(issued[0]?.sig, issued[1]?.sig);
});

test("an authentication refresh never reuses an old challenge proof", async () => {
  const material = new MemoryDeviceKeyStore().generate();
  const signer = Object.freeze({
    publicKeySpkiBase64Url: material.exportPublic().publicKeySpkiBase64Url,
    signBytes: (message: Uint8Array) => material.signBytes(message),
  });
  let issued = 0;
  const result = await requestFreshEdgeAuthority(
    DEVICE_ID,
    signer,
    REQUEST_NONCE,
    true,
    async () => ({ ok: true, data: authorityChallenge }),
    async () => {
      issued += 1;
      return { ok: false, error: createCommandError("AUTHENTICATION_FAILED") };
    },
    async () => true,
  );

  assert.deepEqual(result, {
    ok: false,
    error: createCommandError("RESOURCE_UNAVAILABLE"),
  });
  assert.equal(issued, 1);
});

test("a successful authority response for an old request nonce fails closed", async () => {
  const material = new MemoryDeviceKeyStore().generate();
  const signer = Object.freeze({
    publicKeySpkiBase64Url: material.exportPublic().publicKeySpkiBase64Url,
    signBytes: (message: Uint8Array) => material.signBytes(message),
  });
  const result = await requestFreshEdgeAuthority(
    DEVICE_ID,
    signer,
    REQUEST_NONCE,
    false,
    async () => ({
      ok: true,
      data: { ...authorityChallenge, pairing_code: null },
    }),
    async () => authorityResponse(STALE_REQUEST_NONCE),
    async () => false,
  );

  assert.deepEqual(result, {
    ok: false,
    error: createCommandError("RESOURCE_UNAVAILABLE"),
  });
});

test("authority transport sends the nonce, public key and primary intent in the challenge body", async () => {
  const material = new MemoryDeviceKeyStore().generate();
  const signer = Object.freeze({
    publicKeySpkiBase64Url: material.exportPublic().publicKeySpkiBase64Url,
    signBytes: (message: Uint8Array) => material.signBytes(message),
  });
  const calls: Array<Readonly<{ path: string; body: Readonly<Record<string, unknown>> }>> = [];
  const requester = createEdgeAuthorityRequester({
    deviceId: DEVICE_ID,
    signer,
    executeProtected: async (schema, path, body) => {
      calls.push(Object.freeze({ path, body }));
      const parsed = await schema.safeParseAsync(
        path.endsWith("/challenge")
          ? { ok: true, data: authorityChallenge }
          : { ok: false, error: createCommandError("RESOURCE_UNAVAILABLE") },
      );
      return parsed.success
        ? parsed.data
        : { ok: false, error: createCommandError("RESOURCE_UNAVAILABLE") };
    },
    refreshAuthentication: async () => false,
  });

  await requester(REQUEST_NONCE, true);

  assert.deepEqual(calls[0], {
    path: "/api/v2/edge/authority/challenge",
    body: {
      request_nonce: REQUEST_NONCE,
      device_public_key_spki: signer.publicKeySpkiBase64Url,
      request_primary: true,
    },
  });
  assert.equal(calls[1]?.path, "/api/v2/edge/authority");
  assert.equal(calls[1]?.body.request_nonce, undefined);
  assert.equal(
    (calls[1]?.body.payload as Readonly<Record<string, unknown>> | undefined)?.request_nonce,
    REQUEST_NONCE,
  );
});

test("authority transport sanitizes invalid local request material before network I/O", async () => {
  const material = new MemoryDeviceKeyStore().generate();
  let calls = 0;
  const requester = createEdgeAuthorityRequester({
    deviceId: DEVICE_ID,
    signer: Object.freeze({
      publicKeySpkiBase64Url: material.exportPublic().publicKeySpkiBase64Url,
      signBytes: (message: Uint8Array) => material.signBytes(message),
    }),
    executeProtected: async () => {
      calls += 1;
      return { ok: false, error: createCommandError("RESOURCE_UNAVAILABLE") };
    },
    refreshAuthentication: async () => false,
  });

  assert.deepEqual(await requester("not-a-uuid", true), {
    ok: false,
    error: createCommandError("RESOURCE_UNAVAILABLE"),
  });
  assert.equal(calls, 0);
});
