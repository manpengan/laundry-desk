import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  CURRENT_EDGE_QUEUE_ENVELOPE_VERSION,
  LEGACY_PRIMARY_QUEUE_ENVELOPE_VERSION,
  canonicalizeEdgeReplayForSigning,
  classifyQueueEnvelopeCompatibility,
  parseEdgeQueueEnvelope,
} from "../src/index.js";

const wirePayload = {
  command: "orders.collect_offline",
  version: "1.0.0",
  mode: "direct",
  args: { order_id: "936da01f-9abd-4d9d-80c7-02af85c822a8" },
  idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  dry_run: false,
};

const commonEnvelope = {
  queue_envelope_version: CURRENT_EDGE_QUEUE_ENVELOPE_VERSION,
  contracts_major: 0,
  queue_id: "32ff7821-0b72-4f9c-8ec6-8d7e08500e04",
  enqueued_at: "2026-07-21T01:02:03.000Z",
  payload: wirePayload,
};

describe("A4 versioned Edge queue envelope", () => {
  it("requires a positive per-grant sequence and keeps grant replay free of lease fields", () => {
    const envelope = parseEdgeQueueEnvelope({
      ...commonEnvelope,
      authorization: {
        kind: "grant",
        grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
        per_grant_seq: 12,
      },
    });

    expect(envelope.authorization).toEqual({
      kind: "grant",
      grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
      per_grant_seq: 12,
    });
    expect(() =>
      parseEdgeQueueEnvelope({
        ...commonEnvelope,
        authorization: {
          kind: "grant",
          grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
          per_grant_seq: 0,
        },
      }),
    ).toThrow(ZodError);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.payload)).toBe(true);
  });

  it("reads legacy v2 Primary envelopes without weakening current grant sequencing", () => {
    const legacyPrimary = parseEdgeQueueEnvelope({
      ...commonEnvelope,
      queue_envelope_version: LEGACY_PRIMARY_QUEUE_ENVELOPE_VERSION,
      authorization: {
        kind: "primary_lease",
        grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
        lease_id: "e87a5f8a-e4d3-4404-b9c2-40cdf899e8d1",
        primary_epoch: 7,
        per_lease_seq: 12,
      },
    });

    expect(legacyPrimary.queue_envelope_version).toBe(2);
    expect(legacyPrimary.authorization.kind).toBe("primary_lease");
  });

  it("requires a positive per-lease sequence in the Primary lease branch", () => {
    const authority = {
      kind: "primary_lease",
      grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
      lease_id: "e87a5f8a-e4d3-4404-b9c2-40cdf899e8d1",
      primary_epoch: 7,
      per_lease_seq: 12,
    } as const;
    const envelope = parseEdgeQueueEnvelope({
      ...commonEnvelope,
      authorization: authority,
    });

    expect(envelope.authorization).toEqual(authority);
    expect(() =>
      parseEdgeQueueEnvelope({
        ...commonEnvelope,
        authorization: { ...authority, per_lease_seq: 0 },
      }),
    ).toThrow(ZodError);
  });

  it("rejects cross-branch triad leakage and caller-reported tenant identity", () => {
    expect(() =>
      parseEdgeQueueEnvelope({
        ...commonEnvelope,
        authorization: {
          kind: "grant",
          grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
          per_grant_seq: 1,
          lease_id: "e87a5f8a-e4d3-4404-b9c2-40cdf899e8d1",
          primary_epoch: 7,
          per_lease_seq: 1,
        },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseEdgeQueueEnvelope({
        ...commonEnvelope,
        org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
        authorization: {
          kind: "grant",
          grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
          per_grant_seq: 1,
        },
      }),
    ).toThrow(ZodError);
  });

  it("includes every envelope field, including per-grant sequence, in replay signing bytes", () => {
    const envelope = parseEdgeQueueEnvelope({
      ...commonEnvelope,
      authorization: {
        kind: "grant",
        grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
        per_grant_seq: 1,
      },
    });
    const authority = {
      protocol_version: "1.0.0",
      payload: {
        device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
        envelope,
      },
    };
    const original = canonicalizeEdgeReplayForSigning(authority);

    expect(
      canonicalizeEdgeReplayForSigning({
        ...authority,
        payload: {
          ...authority.payload,
          envelope: {
            ...envelope,
            authorization: { ...envelope.authorization, per_grant_seq: 2 },
          },
        },
      }),
    ).not.toEqual(original);
    expect(
      canonicalizeEdgeReplayForSigning({
        ...authority,
        payload: {
          ...authority.payload,
          envelope: {
            ...envelope,
            payload: { ...envelope.payload, args: { changed: true } },
          },
        },
      }),
    ).not.toEqual(original);
  });
});

describe("A4 queue-envelope compatibility decisions", () => {
  const grantAuthorization = {
    kind: "grant",
    grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
    per_grant_seq: 1,
  } as const;
  const legacyPrimaryAuthorization = {
    kind: "primary_lease",
    grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
    lease_id: "e87a5f8a-e4d3-4404-b9c2-40cdf899e8d1",
    primary_epoch: 7,
    per_lease_seq: 1,
  } as const;

  it("allows replay only inside the supported secure window", () => {
    expect(
      classifyQueueEnvelopeCompatibility(
        { ...commonEnvelope, authorization: grantAuthorization },
        {
          minimum_secure_queue_version: 2,
          current_queue_version: 3,
          current_contracts_major: 0,
        },
      ),
    ).toEqual({ mode: "replay", automatic_replay: true });
  });

  it("routes older and rollback-newer versions to non-replay recovery modes", () => {
    expect(
      classifyQueueEnvelopeCompatibility(
        {
          ...commonEnvelope,
          queue_envelope_version: 1,
          authorization: legacyPrimaryAuthorization,
        },
        {
          minimum_secure_queue_version: 2,
          current_queue_version: 3,
          current_contracts_major: 0,
        },
      ),
    ).toEqual({ mode: "recover_to_arbitration", automatic_replay: false });
    expect(
      classifyQueueEnvelopeCompatibility(
        { ...commonEnvelope, queue_envelope_version: 4, authorization: grantAuthorization },
        {
          minimum_secure_queue_version: 2,
          current_queue_version: 3,
          current_contracts_major: 0,
        },
      ),
    ).toEqual({ mode: "read_only_recovery", automatic_replay: false });
  });

  it("never automatically replays a legacy v2 grant that lacks persistent sequencing", () => {
    expect(
      classifyQueueEnvelopeCompatibility(
        {
          ...commonEnvelope,
          queue_envelope_version: LEGACY_PRIMARY_QUEUE_ENVELOPE_VERSION,
          authorization: {
            kind: "grant",
            grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
          },
        },
        {
          minimum_secure_queue_version: 2,
          current_queue_version: CURRENT_EDGE_QUEUE_ENVELOPE_VERSION,
          current_contracts_major: 0,
        },
      ),
    ).toEqual({ mode: "recover_to_arbitration", automatic_replay: false });
  });

  it("atomically rejects future and older-than-previous contracts majors", () => {
    const window = {
      minimum_secure_queue_version: 2,
      current_queue_version: 3,
      current_contracts_major: 2,
    };
    const envelope = { ...commonEnvelope, authorization: grantAuthorization };

    expect(classifyQueueEnvelopeCompatibility({ ...envelope, contracts_major: 3 }, window)).toEqual(
      { mode: "read_only_recovery", automatic_replay: false },
    );
    expect(classifyQueueEnvelopeCompatibility({ ...envelope, contracts_major: 0 }, window)).toEqual(
      { mode: "recover_to_arbitration", automatic_replay: false },
    );
    expect(classifyQueueEnvelopeCompatibility({ ...envelope, contracts_major: 1 }, window)).toEqual(
      { mode: "replay", automatic_replay: true },
    );
  });

  it("rejects an incoherent local compatibility window", () => {
    expect(() =>
      classifyQueueEnvelopeCompatibility(
        { ...commonEnvelope, authorization: grantAuthorization },
        {
          minimum_secure_queue_version: 4,
          current_queue_version: 3,
          current_contracts_major: 0,
        },
      ),
    ).toThrow(ZodError);
  });
});
