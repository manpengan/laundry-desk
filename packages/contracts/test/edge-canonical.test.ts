import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  canonicalizeCapabilityTicketForSigning,
  canonicalizeExecutionReceiptForSigning,
  canonicalizeForSignatureVerification,
  canonicalizeOfflineGrantForSigning,
  canonicalizePrimaryLeaseForSigning,
  createOfflineGrantRegistrySnapshot,
  defineCommand,
  parseDeviceSignatureExecutionReceiptCandidate,
  parseServerSignatureCapabilityTicketCandidate,
  parseServerSignatureOfflineGrantCandidate,
} from "../src/index.js";
import { canonicalizeAuthorityForTest } from "../src/edge/canonical.js";

const textDecoder = new TextDecoder();
const signature = "Wm9kX2Nhbm9uaWNhbF9zaWduYXR1cmVfZm9yX2VkZ2VfYnJpZGdl";

const capabilityAuthority = {
  protocol_version: "1.0.0",
  payload: {
    action: "print_job",
    job_id: "936da01f-9abd-4d9d-80c7-02af85c822a8",
    staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    origin: "https://desk.example.test",
    issued_at: "2026-07-21T01:02:03.000Z",
    exp: "2026-07-21T01:03:03.000Z",
    nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  },
};

const leaseAuthority = {
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
};

const receiptAuthority = {
  protocol_version: "1.0.0",
  payload: {
    ticket_nonce: capabilityAuthority.payload.nonce,
    result: "succeeded",
    seq: 1,
    at: "2026-07-21T01:02:04.000Z",
  },
};

const offlineDefinition = defineCommand({
  name: "orders.create_offline",
  version: "1.0.0",
  description: "Create an order from the trusted offline queue.",
  description_llm: "Create one offline order under server policy.",
  input: z.strictObject({ order_id: z.uuid() }),
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});
const offlineSnapshot = createOfflineGrantRegistrySnapshot();
const offlineGrantAuthority = {
  protocol_version: "1.0.0",
  payload: {
    grant_id: "f7c4b945-2f08-41f3-b8da-b1af3f7ac547",
    org_id: "692e7b46-2c52-4b77-b790-c2cb4037b9ef",
    store_id: "74b83b3d-a9db-4d82-ba36-bb25a685cd3f",
    staff_id: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
    device_id: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    permission_version: 9,
    allowed_commands: [offlineDefinition.name],
    issued_at: "2026-07-21T01:02:03.000Z",
    ttl_ms: 60_000,
    not_after: "2026-07-21T01:03:03.000Z",
  },
};

describe("A4 canonical signed authority bytes", () => {
  it("uses protocol-specific strict signing input and identical candidate verification bytes", () => {
    const signingBytes = canonicalizeCapabilityTicketForSigning(capabilityAuthority);
    const firstCandidate = parseServerSignatureCapabilityTicketCandidate({
      ...capabilityAuthority,
      sig: signature,
    });
    const secondCandidate = parseServerSignatureCapabilityTicketCandidate({
      ...capabilityAuthority,
      sig: "QW5vdGhlcl92YWxpZF9sb29raW5nX3NpZ25hdHVyZV9jYW5kaWRhdGU",
    });

    expect(canonicalizeForSignatureVerification(firstCandidate)).toEqual(signingBytes);
    expect(canonicalizeForSignatureVerification(secondCandidate)).toEqual(signingBytes);
    expect(textDecoder.decode(signingBytes)).toBe(
      'laundry.edge.capability-ticket.v1\n{"payload":{"action":"print_job","device_id":"01a2eed0-a6c3-493c-a3a7-20bf94b1d678","exp":"2026-07-21T01:03:03.000Z","issued_at":"2026-07-21T01:02:03.000Z","job_id":"936da01f-9abd-4d9d-80c7-02af85c822a8","nonce":"9dfc4424-9b9a-4e52-baaa-c02868f8e7de","origin":"https://desk.example.test","staff_id":"d5a92f5a-653a-4b06-b014-e4a5e0d91f0c"},"protocol_version":"1.0.0"}',
    );
  });

  it("rejects arbitrary authority shapes before they reach canonical signing", () => {
    expect(() =>
      canonicalizeCapabilityTicketForSigning({
        ...capabilityAuthority,
        payload: { ...capabilityAuthority.payload, action: "refund" },
      }),
    ).toThrow();
    expect(() =>
      canonicalizeCapabilityTicketForSigning({
        ...capabilityAuthority,
        payload: { ...capabilityAuthority.payload, unexpected: true },
      }),
    ).toThrow();
    expect(() =>
      canonicalizeCapabilityTicketForSigning({ ...capabilityAuthority, protocol_version: "v1" }),
    ).toThrow();
    expect(() =>
      canonicalizeForSignatureVerification({ ...capabilityAuthority, sig: signature } as never),
    ).toThrow(/registered candidate/u);
  });

  it("rejects top-level key collisions and preserves UTF-16 lexical integer-key order", () => {
    expect(() =>
      canonicalizeAuthorityForTest("test.domain.v1", {
        "payload,protocol_version": {},
      }),
    ).toThrow(/only protocol_version and payload/u);

    const bytes = canonicalizeAuthorityForTest("test.domain.v1", {
      protocol_version: "1.0.0",
      payload: { 2: "two", 10: "ten" },
    });
    expect(textDecoder.decode(bytes)).toContain('{"10":"ten","2":"two"}');
  });

  it("separates capability and lease signing domains", () => {
    const capabilityBytes = canonicalizeCapabilityTicketForSigning(capabilityAuthority);
    const leaseBytes = canonicalizePrimaryLeaseForSigning(leaseAuthority);

    expect(textDecoder.decode(capabilityBytes)).toMatch(/^laundry\.edge\.capability-ticket\.v1\n/u);
    expect(textDecoder.decode(leaseBytes)).toMatch(/^laundry\.edge\.primary-lease\.v1\n/u);
    expect(capabilityBytes).not.toEqual(leaseBytes);
  });

  it("keeps receipt and grant signing helpers aligned with registered candidates", () => {
    const receiptCandidate = parseDeviceSignatureExecutionReceiptCandidate({
      ...receiptAuthority,
      sig: signature,
    });
    const grantCandidate = parseServerSignatureOfflineGrantCandidate(
      { ...offlineGrantAuthority, sig: signature },
      offlineSnapshot,
    );

    expect(canonicalizeForSignatureVerification(receiptCandidate)).toEqual(
      canonicalizeExecutionReceiptForSigning(receiptAuthority),
    );
    expect(canonicalizeForSignatureVerification(grantCandidate)).toEqual(
      canonicalizeOfflineGrantForSigning(offlineGrantAuthority, offlineSnapshot),
    );
  });
});
