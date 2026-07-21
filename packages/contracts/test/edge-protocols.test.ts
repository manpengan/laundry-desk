import { describe, expect, it } from "vitest";
import { z, ZodError } from "zod";

import {
  createOfflineGrantRegistrySnapshot,
  defineCommand,
  isServerSignatureOfflineGrantCandidate,
  isServerSignaturePrimaryLeaseCandidate,
  parseServerSignatureOfflineGrantCandidate,
  parseServerSignaturePrimaryLeaseCandidate,
  OFFLINE_GRANT_MAX_TTL_MS,
  validateOfflineGrantAllowedCommands,
} from "../src/index.js";

const signature = "Wm9kX2Nhbm9uaWNhbF9zaWduYXR1cmVfZm9yX2VkZ2VfYnJpZGdl";

const leaseEnvelope = {
  protocol_version: "1.0.0",
  payload: {
    lease_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
    store_id: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
    device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    primary_epoch: 7,
    issued_at: "2026-07-21T01:02:03.000Z",
    ttl_ms: 60_000,
    max_clock_skew_ms: 1_000,
    not_after: "2026-07-21T01:03:03.000Z",
  },
  sig: signature,
};

const commandInput = z.strictObject({ order_id: z.uuid() });

const defineOfflineCommand = (
  name: string,
  offlineMode: "denied" | "grant" | "primary_lease",
  version = "1.0.0",
) =>
  defineCommand({
    name,
    version,
    description: `Execute ${name}`,
    description_llm: `Execute ${name} under server policy.`,
    input: commandInput,
    risk: offlineMode === "primary_lease" ? "R3" : "R1",
    invariants: [],
    idempotent: true,
    sideEffects: [],
    offline_mode: offlineMode,
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
  });

const definitions = [
  defineOfflineCommand("orders.create_offline", "grant"),
  defineOfflineCommand("orders.collect_offline", "primary_lease"),
  defineOfflineCommand("orders.refund", "denied"),
  defineOfflineCommand("orders.version_grant", "grant", "1.0.0"),
  defineOfflineCommand("orders.version_grant", "grant", "1.1.0"),
  defineOfflineCommand("orders.version_denied", "grant", "1.0.0"),
  defineOfflineCommand("orders.version_denied", "denied", "2.0.0"),
] as const;

const registrySnapshot = createOfflineGrantRegistrySnapshot();

const grantEnvelope = {
  protocol_version: "1.0.0",
  payload: {
    grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
    org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
    store_id: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
    staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    permission_version: 9,
    allowed_commands: ["orders.create_offline", "orders.collect_offline"],
    issued_at: "2026-07-21T01:02:03.000Z",
    ttl_ms: 43_200_000,
    not_after: "2026-07-21T13:02:03.000Z",
  },
  sig: signature,
};

describe("A4 Primary lease contract", () => {
  it("keeps not_after inside the immutable server-signed payload", () => {
    const lease = parseServerSignaturePrimaryLeaseCandidate(leaseEnvelope);

    expect(isServerSignaturePrimaryLeaseCandidate(lease)).toBe(true);
    expect(lease.payload.not_after).toBe("2026-07-21T01:03:03.000Z");
    expect(Object.keys(lease.payload)).toEqual([
      "lease_id",
      "store_id",
      "device_id",
      "primary_epoch",
      "issued_at",
      "ttl_ms",
      "max_clock_skew_ms",
      "not_after",
    ]);
  });

  it("rejects mismatched signed deadlines and invalid integer boundaries", () => {
    expect(() =>
      parseServerSignaturePrimaryLeaseCandidate({
        ...leaseEnvelope,
        payload: { ...leaseEnvelope.payload, not_after: "2026-07-21T01:03:02.999Z" },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignaturePrimaryLeaseCandidate({
        ...leaseEnvelope,
        payload: { ...leaseEnvelope.payload, max_clock_skew_ms: -1 },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignaturePrimaryLeaseCandidate({
        ...leaseEnvelope,
        payload: { ...leaseEnvelope.payload, ttl_ms: 2_147_483_648 },
      }),
    ).toThrow(ZodError);
  });
});

describe("A4 offline grant contract", () => {
  it("constructs a server-signed grant and reports commands that still need a lease", () => {
    const grant = parseServerSignatureOfflineGrantCandidate(grantEnvelope, registrySnapshot);
    const authorization = validateOfflineGrantAllowedCommands(
      grant.payload.allowed_commands,
      registrySnapshot,
    );

    expect(isServerSignatureOfflineGrantCandidate(grant)).toBe(true);
    expect(authorization.primary_lease_commands).toEqual(["orders.collect_offline"]);
    expect(Object.isFrozen(authorization.primary_lease_commands)).toBe(true);
  });

  it("rejects a grant that names an offline-denied command", () => {
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(
        {
          ...grantEnvelope,
          payload: { ...grantEnvelope.payload, allowed_commands: ["orders.refund"] },
        },
        registrySnapshot,
      ),
    ).toThrow(/offline_mode is denied/u);
  });

  it("rejects unknown, duplicate, empty, or expired grant authority", () => {
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(
        {
          ...grantEnvelope,
          payload: { ...grantEnvelope.payload, allowed_commands: ["orders.unknown"] },
        },
        registrySnapshot,
      ),
    ).toThrow(/not registered/u);
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(
        {
          ...grantEnvelope,
          payload: {
            ...grantEnvelope.payload,
            allowed_commands: ["orders.create_offline", "orders.create_offline"],
          },
        },
        registrySnapshot,
      ),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(
        {
          ...grantEnvelope,
          payload: { ...grantEnvelope.payload, allowed_commands: [] },
        },
        registrySnapshot,
      ),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(
        {
          ...grantEnvelope,
          payload: { ...grantEnvelope.payload, not_after: grantEnvelope.payload.issued_at },
        },
        registrySnapshot,
      ),
    ).toThrow(ZodError);
  });

  it("enforces the signed grant deadline and conservative M1 maximum lifetime", () => {
    expect(OFFLINE_GRANT_MAX_TTL_MS).toBe(43_200_000);
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(
        {
          ...grantEnvelope,
          payload: { ...grantEnvelope.payload, ttl_ms: OFFLINE_GRANT_MAX_TTL_MS + 1 },
        },
        registrySnapshot,
      ),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(
        {
          ...grantEnvelope,
          payload: { ...grantEnvelope.payload, not_after: "2026-07-21T13:02:02.999Z" },
        },
        registrySnapshot,
      ),
    ).toThrow(ZodError);
  });

  it("fails closed across supported command versions and rejects direct duplicate input", () => {
    expect(() =>
      validateOfflineGrantAllowedCommands(
        ["orders.create_offline", "orders.create_offline"],
        registrySnapshot,
      ),
    ).toThrow(ZodError);

    expect(
      validateOfflineGrantAllowedCommands(["orders.version_grant"], registrySnapshot)
        .allowed_commands,
    ).toEqual(["orders.version_grant"]);

    expect(() =>
      validateOfflineGrantAllowedCommands(["orders.version_denied"], registrySnapshot),
    ).toThrow(/offline_mode is denied/u);
  });

  it("seals the one authoritative registry and rejects synchronized caller-owned subsets", () => {
    const callerOwnedFactory = createOfflineGrantRegistrySnapshot as unknown as (
      ...inputs: readonly unknown[]
    ) => unknown;
    expect(() =>
      callerOwnedFactory(
        [definitions[5]],
        [{ name: definitions[5].name, version: definitions[5].version }],
      ),
    ).toThrow(/does not accept caller-owned registry subsets/u);
    expect(registrySnapshot.definition_refs).toEqual(
      expect.arrayContaining([
        { name: "orders.version_denied", version: "1.0.0" },
        { name: "orders.version_denied", version: "2.0.0" },
      ]),
    );
    expect(() => defineOfflineCommand("orders.registered_too_late", "grant")).toThrow(
      /already sealed/u,
    );
    expect(() =>
      parseServerSignatureOfflineGrantCandidate(grantEnvelope, definitions as never),
    ).toThrow(/registry snapshot provenance/u);
    expect(() =>
      validateOfflineGrantAllowedCommands(grantEnvelope.payload.allowed_commands, {
        ...registrySnapshot,
      } as never),
    ).toThrow(/registry snapshot provenance/u);
  });
});
