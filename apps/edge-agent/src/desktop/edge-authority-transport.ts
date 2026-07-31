import {
  EdgeAuthorityChallengeRequestSchema,
  EdgeAuthorityChallengeResponseSchema,
  EdgeAuthorityResponseSchema,
  createCommandError,
  type EdgeAuthorityResponse,
} from "@laundry/contracts";

import { requestFreshEdgeAuthority, type DeviceRequestSigner } from "./edge-http.js";
import type { AsyncSchema, DesktopFailure, ResultEnvelope } from "./http-transport-support.js";

type ProtectedJsonExecutor = <T extends ResultEnvelope>(
  schema: AsyncSchema<T>,
  path: string,
  body: Readonly<Record<string, unknown>>,
  contentType: undefined,
  retryAuthentication: boolean,
) => Promise<T | DesktopFailure>;

type EdgeAuthorityRequesterOptions = Readonly<{
  deviceId: string;
  signer: DeviceRequestSigner | undefined;
  executeProtected: ProtectedJsonExecutor;
  refreshAuthentication: () => Promise<boolean>;
}>;

export function createEdgeAuthorityRequester(
  options: EdgeAuthorityRequesterOptions,
): (requestNonce: string, requestPrimary: boolean) => Promise<EdgeAuthorityResponse> {
  const unavailable = (): EdgeAuthorityResponse =>
    Object.freeze({
      ok: false as const,
      error: createCommandError("RESOURCE_UNAVAILABLE"),
    });
  const signer = options.signer;
  if (signer === undefined) {
    return async () => unavailable();
  }
  return async (requestNonce, requestPrimary) => {
    try {
      const challengeRequest = EdgeAuthorityChallengeRequestSchema.parse({
        request_nonce: requestNonce,
        device_public_key_spki: signer.publicKeySpkiBase64Url,
        request_primary: requestPrimary,
      });
      return await requestFreshEdgeAuthority(
        options.deviceId,
        signer,
        requestNonce,
        requestPrimary,
        () =>
          options.executeProtected(
            EdgeAuthorityChallengeResponseSchema,
            "/api/v2/edge/authority/challenge",
            challengeRequest,
            undefined,
            false,
          ),
        (body) =>
          options.executeProtected(
            EdgeAuthorityResponseSchema,
            "/api/v2/edge/authority",
            body,
            undefined,
            false,
          ),
        options.refreshAuthentication,
      );
    } catch {
      return unavailable();
    }
  };
}
