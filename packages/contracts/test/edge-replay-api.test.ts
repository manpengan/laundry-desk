import { describe, expect, it } from "vitest";

import {
  EdgeAuthorityChallengeResponseSchema,
  EdgeAuthorityRequestSchema,
  EdgeReplayRequestSchema,
  canonicalizeEdgeDeviceRegistrationForSigning,
  canonicalizeEdgeReplayForSigning,
} from "../src/index.js";

const deviceId = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const signature = "A".repeat(86);
const registrationAuthority = {
  protocol_version: "1.0.0",
  payload: {
    org_id: "11a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    store_id: "21a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    staff_id: "31a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    session_id: "41a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    session_version: 3,
    permission_version: 7,
    device_id: deviceId,
    device_public_key_spki: "MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    challenge_id: "51a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    challenge: "A".repeat(43),
    request_nonce: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    request_primary: false,
    pairing_code: null,
  },
};
const replayAuthority = {
  protocol_version: "1.0.0",
  payload: {
    device_id: deviceId,
    envelope: {
      queue_envelope_version: 1,
      contracts_major: 0,
      queue_id: "32ff7821-0b72-4f9c-8ec6-8d7e08500e04",
      enqueued_at: "2026-07-21T01:02:03.000Z",
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
        primary_epoch: 7,
        per_lease_seq: 12,
      },
    },
  },
};

describe("device-authenticated Edge replay API", () => {
  it("binds a short-lived challenge to the complete authenticated session authority", () => {
    expect(
      EdgeAuthorityChallengeResponseSchema.parse({
        ok: true,
        data: {
          org_id: registrationAuthority.payload.org_id,
          store_id: registrationAuthority.payload.store_id,
          staff_id: registrationAuthority.payload.staff_id,
          session_id: registrationAuthority.payload.session_id,
          session_version: registrationAuthority.payload.session_version,
          permission_version: registrationAuthority.payload.permission_version,
          device_id: registrationAuthority.payload.device_id,
          challenge_id: registrationAuthority.payload.challenge_id,
          challenge: registrationAuthority.payload.challenge,
          request_nonce: registrationAuthority.payload.request_nonce,
          pairing_code: registrationAuthority.payload.pairing_code,
          expires_at: "2026-07-21T01:02:33.000Z",
        },
      }),
    ).toMatchObject({
      ok: true,
      data: { session_version: 3, permission_version: 7, device_id: deviceId },
    });
  });

  it("requires a strict proof-of-possession authority request", () => {
    expect(EdgeAuthorityRequestSchema.parse({ ...registrationAuthority, sig: signature })).toEqual({
      ...registrationAuthority,
      sig: signature,
    });
    expect(() =>
      EdgeAuthorityRequestSchema.parse({
        ...registrationAuthority,
        payload: { ...registrationAuthority.payload, unexpected_staff_id: deviceId },
        sig: signature,
      }),
    ).toThrow();
  });

  it("covers the complete queue envelope with a separate signing domain", () => {
    EdgeReplayRequestSchema.parse({ ...replayAuthority, sig: signature });
    const registrationBytes = canonicalizeEdgeDeviceRegistrationForSigning(registrationAuthority);
    const replayBytes = canonicalizeEdgeReplayForSigning(replayAuthority);

    expect(new TextDecoder().decode(registrationBytes)).toMatch(
      /^laundry\.edge\.device-registration\.v1\n/u,
    );
    expect(new TextDecoder().decode(replayBytes)).toMatch(/^laundry\.edge\.replay\.v1\n/u);
    expect(replayBytes).not.toEqual(registrationBytes);
    expect(
      canonicalizeEdgeDeviceRegistrationForSigning({
        ...registrationAuthority,
        payload: { ...registrationAuthority.payload, challenge: "B".repeat(43) },
      }),
    ).not.toEqual(registrationBytes);
    expect(() =>
      canonicalizeEdgeReplayForSigning({
        ...replayAuthority,
        payload: {
          ...replayAuthority.payload,
          envelope: { ...replayAuthority.payload.envelope, queue_id: deviceId },
        },
        unexpected: true,
      }),
    ).toThrow();
  });
});
