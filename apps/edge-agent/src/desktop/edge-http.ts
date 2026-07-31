import {
  DesktopCommandExecuteResultSchema,
  EdgeAuthorityRequestSchema,
  EdgeReplayRequestSchema,
  canonicalizeEdgeDeviceRegistrationForSigning,
  canonicalizeEdgeReplayForSigning,
  createCommandError,
  type DesktopCommandExecuteResult,
  type EdgeAuthorityChallengeData,
  type EdgeAuthorityChallengeResponse,
  type EdgeAuthorityRequest,
  type EdgeAuthorityResponse,
  type EdgeQueueEnvelope,
  type EdgeReplayRequest,
  type EdgeReplayResponse,
} from "@laundry/contracts";

export type DeviceRequestSigner = Readonly<{
  publicKeySpkiBase64Url: string;
  signBytes: (message: Uint8Array) => Uint8Array;
}>;

function signature(signer: DeviceRequestSigner, message: Uint8Array): string {
  return Buffer.from(signer.signBytes(message)).toString("base64url");
}

export function createSignedAuthorityRequest(
  deviceId: string,
  challenge: EdgeAuthorityChallengeData,
  signer: DeviceRequestSigner,
  expectedRequestNonce: string,
  requestPrimary: boolean,
): EdgeAuthorityRequest {
  if (challenge.device_id !== deviceId) {
    throw new Error("Edge authority challenge device mismatch");
  }
  if (challenge.request_nonce !== expectedRequestNonce) {
    throw new Error("Edge authority challenge request nonce mismatch");
  }
  const authority = Object.freeze({
    protocol_version: "1.0.0",
    payload: Object.freeze({
      org_id: challenge.org_id,
      store_id: challenge.store_id,
      staff_id: challenge.staff_id,
      session_id: challenge.session_id,
      session_version: challenge.session_version,
      permission_version: challenge.permission_version,
      device_id: deviceId,
      device_public_key_spki: signer.publicKeySpkiBase64Url,
      challenge_id: challenge.challenge_id,
      challenge: challenge.challenge,
      request_nonce: expectedRequestNonce,
      request_primary: requestPrimary,
      pairing_code: challenge.pairing_code,
    }),
  });
  return EdgeAuthorityRequestSchema.parse({
    ...authority,
    sig: signature(signer, canonicalizeEdgeDeviceRegistrationForSigning(authority)),
  });
}

const unavailableAuthority = (): EdgeAuthorityResponse =>
  Object.freeze({ ok: false as const, error: createCommandError("RESOURCE_UNAVAILABLE") });

const isAuthenticationFailure = (
  result: EdgeAuthorityChallengeResponse | EdgeAuthorityResponse,
): boolean => !result.ok && result.error.code === "AUTHENTICATION_FAILED";

/** A 401 restarts the complete challenge/proof exchange and never reuses a signed body. */
export async function requestFreshEdgeAuthority(
  deviceId: string,
  signer: DeviceRequestSigner | undefined,
  expectedRequestNonce: string,
  requestPrimary: boolean,
  requestChallenge: () => Promise<EdgeAuthorityChallengeResponse>,
  issue: (request: EdgeAuthorityRequest) => Promise<EdgeAuthorityResponse>,
  refreshAuthentication: () => Promise<boolean>,
): Promise<EdgeAuthorityResponse> {
  if (signer === undefined) return unavailableAuthority();
  const usedChallengeIds = new Set<string>();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const challenge = await requestChallenge();
    if (!challenge.ok) {
      if (attempt === 0 && isAuthenticationFailure(challenge) && (await refreshAuthentication())) {
        continue;
      }
      return challenge;
    }
    if (usedChallengeIds.has(challenge.data.challenge_id)) return unavailableAuthority();
    usedChallengeIds.add(challenge.data.challenge_id);
    let request: EdgeAuthorityRequest;
    try {
      request = createSignedAuthorityRequest(
        deviceId,
        challenge.data,
        signer,
        expectedRequestNonce,
        requestPrimary,
      );
    } catch {
      return unavailableAuthority();
    }
    const issued = await issue(request);
    if (attempt === 0 && isAuthenticationFailure(issued) && (await refreshAuthentication())) {
      continue;
    }
    if (
      issued.ok &&
      (issued.data.offline_grant.payload.request_nonce !== expectedRequestNonce ||
        (!requestPrimary && issued.data.primary_lease !== null))
    ) {
      return unavailableAuthority();
    }
    return issued;
  }
  return unavailableAuthority();
}

export function createSignedReplayRequest(
  deviceId: string,
  envelope: EdgeQueueEnvelope,
  signer: DeviceRequestSigner,
): EdgeReplayRequest {
  const authority = Object.freeze({
    protocol_version: "1.0.0",
    payload: Object.freeze({ device_id: deviceId, envelope }),
  });
  return EdgeReplayRequestSchema.parse({
    ...authority,
    sig: signature(signer, canonicalizeEdgeReplayForSigning(authority)),
  });
}

export function projectReplayResponse(response: EdgeReplayResponse): DesktopCommandExecuteResult {
  return DesktopCommandExecuteResultSchema.parse(response.ok ? response.data.command : response);
}
