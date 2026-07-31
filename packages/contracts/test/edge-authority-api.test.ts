import { describe, expect, it } from "vitest";

import {
  EdgeAuthorityChallengeDataSchema,
  EdgeAuthorityChallengeRequestSchema,
  EdgeAuthorityDataSchema,
  EdgeAuthorityRequestSchema,
  OfflineGrantPayloadSchema,
} from "../src/index.js";

const ids = Object.freeze({
  org: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  store: "11a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  staff: "21a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  device: "31a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  session: "41a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  challenge: "51a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  requestNonce: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  grant: "71a2eed0-a6c3-493c-a3a7-20bf94b1d678",
});
const devicePublicKeySpki = "A".repeat(60);
const challengeSecret = "B".repeat(43);
const signature = "C".repeat(86);

const challengeRequest = Object.freeze({
  request_nonce: ids.requestNonce,
  device_public_key_spki: devicePublicKeySpki,
  request_primary: false,
});

const challengeData = Object.freeze({
  org_id: ids.org,
  store_id: ids.store,
  staff_id: ids.staff,
  session_id: ids.session,
  session_version: 1,
  permission_version: 2,
  device_id: ids.device,
  challenge_id: ids.challenge,
  challenge: challengeSecret,
  request_nonce: ids.requestNonce,
  pairing_code: null,
  expires_at: "2026-07-31T01:01:00.000Z",
});

const registrationPayload = Object.freeze({
  org_id: ids.org,
  store_id: ids.store,
  staff_id: ids.staff,
  session_id: ids.session,
  session_version: 1,
  permission_version: 2,
  device_id: ids.device,
  device_public_key_spki: devicePublicKeySpki,
  challenge_id: ids.challenge,
  challenge: challengeSecret,
  request_nonce: ids.requestNonce,
  request_primary: false,
  pairing_code: null,
});

describe("Edge authority intent contract", () => {
  it("binds each challenge to one request nonce, public key, and explicit Primary intent", () => {
    expect(EdgeAuthorityChallengeRequestSchema.parse(challengeRequest)).toEqual(challengeRequest);
    expect(() =>
      EdgeAuthorityChallengeRequestSchema.parse({
        request_nonce: ids.requestNonce,
        request_primary: false,
      }),
    ).toThrow();
    expect(() =>
      EdgeAuthorityChallengeRequestSchema.parse({ ...challengeRequest, unexpected: true }),
    ).toThrow();
  });

  it("echoes the nonce and returns a nullable one-time pairing code", () => {
    expect(EdgeAuthorityChallengeDataSchema.parse(challengeData)).toEqual(challengeData);
    expect(
      EdgeAuthorityChallengeDataSchema.parse({ ...challengeData, pairing_code: "123456" })
        .pairing_code,
    ).toBe("123456");
    expect(() =>
      EdgeAuthorityChallengeDataSchema.parse({ ...challengeData, pairing_code: "12345" }),
    ).toThrow();
  });

  it("covers nonce, pairing code, and Primary intent with the device signature", () => {
    const request = EdgeAuthorityRequestSchema.parse({
      protocol_version: "1.0.0",
      payload: registrationPayload,
      sig: signature,
    });
    expect(request.payload.request_nonce).toBe(ids.requestNonce);
    expect(request.payload.pairing_code).toBeNull();
    expect(request.payload.request_primary).toBe(false);
    expect(() =>
      EdgeAuthorityRequestSchema.parse({
        protocol_version: "1.0.0",
        payload: { ...registrationPayload, request_nonce: ids.challenge },
        sig: signature,
      }),
    ).not.toThrow();
  });

  it("persists the request nonce in signed grants and permits grant-only responses", () => {
    const payload = OfflineGrantPayloadSchema.parse({
      grant_id: ids.grant,
      org_id: ids.org,
      store_id: ids.store,
      staff_id: ids.staff,
      device_id: ids.device,
      request_nonce: ids.requestNonce,
      permission_version: 2,
      allowed_commands: ["order.receive"],
      issued_at: "2026-07-31T01:00:00.000Z",
      ttl_ms: 60_000,
      not_after: "2026-07-31T01:01:00.000Z",
    });
    expect(payload.request_nonce).toBe(ids.requestNonce);

    const response = EdgeAuthorityDataSchema.parse({
      server_public_key_spki: Buffer.from("server-key").toString("base64"),
      offline_grant: {
        protocol_version: "1.0.0",
        payload,
        sig: signature,
      },
      primary_lease: null,
    });
    expect(response.primary_lease).toBeNull();
  });
});
