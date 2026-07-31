import {
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
  type KeyPairKeyObjectResult,
} from "node:crypto";

import {
  EdgeAuthorityRequestSchema,
  canonicalizeEdgeDeviceRegistrationForSigning,
  type EdgeAuthorityChallengeData,
  type EdgeAuthorityChallengeRequest,
  type EdgeAuthorityRequest,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { createEdgeAuthorityService, type EdgeAuthorityService } from "./authority-service.js";
import { createMemoryAuthorityStore } from "./memory-authority-store.js";

export const AUTHORITY_TEST_IDS = Object.freeze({
  org: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  store: "11a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  admin: "21a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  staff: "22a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  deviceA: "31a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  deviceB: "32a2eed0-a6c3-493c-a3a7-20bf94b1d678",
});

export function authoritySession(
  role: "admin" | "staff",
  deviceId: string = AUTHORITY_TEST_IDS.deviceA,
  authenticationMethod: "password" | "pin" | "refresh" = "password",
): AuthorizedSession {
  const staffId = role === "admin" ? AUTHORITY_TEST_IDS.admin : AUTHORITY_TEST_IDS.staff;
  return Object.freeze({
    session: Object.freeze({
      session_id: randomUUID(),
      session_version: 1,
      org_id: AUTHORITY_TEST_IDS.org,
      store_id: AUTHORITY_TEST_IDS.store,
      staff_id: staffId,
      device_id: deviceId,
      permission_version: 4,
      authentication_method: authenticationMethod,
      status: "active",
      family_id: randomUUID(),
      created_at: 1,
      revoked_at: null,
    }),
    authority: Object.freeze({
      staff_id: staffId,
      display_name: role === "admin" ? "Admin" : "Staff",
      role,
      permission_version: 4,
      is_privacy_admin: role === "admin",
    }),
  });
}

export type AuthorityHarness = Readonly<{
  service: EdgeAuthorityService;
  store: ReturnType<typeof createMemoryAuthorityStore>;
  setNow: (iso: string) => void;
  advance: (milliseconds: number) => void;
}>;

export function createAuthorityHarness(): AuthorityHarness {
  let nowMs = Date.parse("2026-07-31T01:02:03.000Z");
  const store = createMemoryAuthorityStore({ now: () => new Date(nowMs) });
  const service = createEdgeAuthorityService({
    store,
    randomUUID,
    keyPair: generateKeyPairSync("ed25519"),
    randomPairingCode: () => "123456",
  });
  return Object.freeze({
    service,
    store,
    setNow: (iso) => {
      nowMs = Date.parse(iso);
    },
    advance: (milliseconds) => {
      nowMs += milliseconds;
    },
  });
}

export type AuthorityAttempt = Readonly<{
  challengeInput: EdgeAuthorityChallengeRequest;
  challenge: EdgeAuthorityChallengeData;
  request: EdgeAuthorityRequest;
}>;

function publicKeySpki(keys: KeyPairKeyObjectResult): string {
  return keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
}

export function signAuthorityRequest(
  challenge: EdgeAuthorityChallengeData,
  challengeInput: EdgeAuthorityChallengeRequest,
  privateKey: KeyObject,
  overrides: Readonly<{
    requestNonce?: string;
    devicePublicKeySpki?: string;
    requestPrimary?: boolean;
    pairingCode?: string | null;
  }> = {},
): EdgeAuthorityRequest {
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
      device_public_key_spki:
        overrides.devicePublicKeySpki ?? challengeInput.device_public_key_spki,
      challenge_id: challenge.challenge_id,
      challenge: challenge.challenge,
      request_nonce: overrides.requestNonce ?? challengeInput.request_nonce,
      request_primary: overrides.requestPrimary ?? challengeInput.request_primary,
      pairing_code:
        overrides.pairingCode === undefined ? challenge.pairing_code : overrides.pairingCode,
    }),
  });
  return EdgeAuthorityRequestSchema.parse({
    ...authority,
    sig: sign(null, canonicalizeEdgeDeviceRegistrationForSigning(authority), privateKey).toString(
      "base64url",
    ),
  });
}

export async function beginAuthorityAttempt(
  service: EdgeAuthorityService,
  session: AuthorizedSession,
  keys: KeyPairKeyObjectResult,
  requestPrimary = false,
  requestNonce = randomUUID(),
): Promise<AuthorityAttempt | null> {
  const challengeInput = Object.freeze({
    request_nonce: requestNonce,
    device_public_key_spki: publicKeySpki(keys),
    request_primary: requestPrimary,
  });
  const challenge = await service.challenge(session, challengeInput);
  if (challenge === null) return null;
  return Object.freeze({
    challengeInput,
    challenge,
    request: signAuthorityRequest(challenge, challengeInput, keys.privateKey),
  });
}

export const newDeviceKeys = (): KeyPairKeyObjectResult => generateKeyPairSync("ed25519");
