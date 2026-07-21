import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  EdgeOriginSchema,
  isDeviceSignatureExecutionReceiptCandidate,
  isServerSignatureCapabilityTicketCandidate,
  parseDeviceSignatureExecutionReceiptCandidate,
  parseServerSignatureCapabilityTicketCandidate,
} from "../src/index.js";

const capabilityEnvelope = {
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
  sig: "Wm9kX2Nhbm9uaWNhbF9zaWduYXR1cmVfZm9yX2VkZ2VfYnJpZGdl",
};

const receiptEnvelope = {
  protocol_version: "1.0.0",
  payload: {
    ticket_nonce: capabilityEnvelope.payload.nonce,
    result: "succeeded",
    seq: 1,
    at: "2026-07-21T01:02:04.000Z",
  },
  sig: "RGV2aWNlX3NpZ25hdHVyZV9mb3JfZXhlY3V0aW9uX3JlY2VpcHQ",
};

describe("A4 signed-envelope provenance", () => {
  it("registers each signer direction and rejects structural clones", () => {
    const capability = parseServerSignatureCapabilityTicketCandidate(capabilityEnvelope);
    const receipt = parseDeviceSignatureExecutionReceiptCandidate(receiptEnvelope);

    expect(isServerSignatureCapabilityTicketCandidate(capability)).toBe(true);
    expect(isDeviceSignatureExecutionReceiptCandidate(receipt)).toBe(true);
    expect(isServerSignatureCapabilityTicketCandidate(receipt)).toBe(false);
    expect(isDeviceSignatureExecutionReceiptCandidate(capability)).toBe(false);
    expect(isServerSignatureCapabilityTicketCandidate({ ...capability })).toBe(false);
    expect(isServerSignatureCapabilityTicketCandidate(JSON.parse(JSON.stringify(capability)))).toBe(
      false,
    );
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.payload)).toBe(true);
  });

  it("rejects unknown, missing, invalid timestamp, and malformed signature fields", () => {
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({ ...capabilityEnvelope, unexpected: true }),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...capabilityEnvelope,
        payload: { ...capabilityEnvelope.payload, issued_at: "2026-07-21T01:02:03Z" },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({ ...capabilityEnvelope, sig: "***" }),
    ).toThrow(ZodError);
    const missingPayload: Record<string, unknown> = { ...capabilityEnvelope };
    delete missingPayload.payload;
    expect(() => parseServerSignatureCapabilityTicketCandidate(missingPayload)).toThrow(ZodError);
  });

  it("rejects unsafe capability windows, origins, and receipt sequences", () => {
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...capabilityEnvelope,
        payload: { ...capabilityEnvelope.payload, exp: capabilityEnvelope.payload.issued_at },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseServerSignatureCapabilityTicketCandidate({
        ...capabilityEnvelope,
        payload: { ...capabilityEnvelope.payload, origin: "http://desk.example.test" },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseDeviceSignatureExecutionReceiptCandidate({
        ...receiptEnvelope,
        payload: { ...receiptEnvelope.payload, seq: 0 },
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseDeviceSignatureExecutionReceiptCandidate({
        ...receiptEnvelope,
        payload: { ...receiptEnvelope.payload, unexpected: true },
      }),
    ).toThrow(ZodError);
  });

  it("normalizes malformed and non-origin-form values into Zod failures", () => {
    expect(() => EdgeOriginSchema.safeParse("not-url")).not.toThrow();
    expect(EdgeOriginSchema.safeParse("not-url").success).toBe(false);
    expect(EdgeOriginSchema.safeParse("https://desk.example.test/path").success).toBe(false);
    expect(EdgeOriginSchema.safeParse("https://desk.example.test?query=1").success).toBe(false);
    expect(EdgeOriginSchema.safeParse("https://desk.example.test#fragment").success).toBe(false);
    expect(EdgeOriginSchema.safeParse("https://desk.example.test:443").success).toBe(false);
    expect(EdgeOriginSchema.safeParse("https://staff@desk.example.test").success).toBe(false);
    expect(EdgeOriginSchema.safeParse("app://laundry-desk/path").success).toBe(false);
    expect(EdgeOriginSchema.safeParse("https://desk.example.test").success).toBe(true);
    expect(EdgeOriginSchema.safeParse("app://laundry-desk").success).toBe(true);
  });
});
