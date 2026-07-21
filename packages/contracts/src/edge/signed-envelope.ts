import { z } from "zod";

import { SemVerSchema } from "../registry/primitives.js";
import {
  type OfflineGrantRegistrySnapshot,
  validateOfflineGrantAllowedCommands,
} from "./offline-grant.js";
import { Base64UrlSignatureSchema } from "./primitives.js";
import {
  CapabilityTicketPayloadSchema,
  ExecutionReceiptPayloadSchema,
  OfflineGrantPayloadSchema,
  PrimaryLeasePayloadSchema,
  type CapabilityTicketPayload,
  type ExecutionReceiptPayload,
  type OfflineGrantPayload,
  type PrimaryLeasePayload,
} from "./protocols.js";

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

type SignatureCandidateFields<TPayload> = Readonly<{
  protocol_version: string;
  payload: DeepReadonly<TPayload>;
  sig: string;
}>;

declare const CAPABILITY_TICKET_CANDIDATE_BRAND: unique symbol;
declare const EXECUTION_RECEIPT_CANDIDATE_BRAND: unique symbol;
declare const OFFLINE_GRANT_CANDIDATE_BRAND: unique symbol;
declare const PRIMARY_LEASE_CANDIDATE_BRAND: unique symbol;

export type ServerSignatureCapabilityTicketCandidate =
  SignatureCandidateFields<CapabilityTicketPayload> &
    Readonly<{ [CAPABILITY_TICKET_CANDIDATE_BRAND]: true }>;
export type DeviceSignatureExecutionReceiptCandidate =
  SignatureCandidateFields<ExecutionReceiptPayload> &
    Readonly<{ [EXECUTION_RECEIPT_CANDIDATE_BRAND]: true }>;
export type ServerSignatureOfflineGrantCandidate = SignatureCandidateFields<OfflineGrantPayload> &
  Readonly<{ [OFFLINE_GRANT_CANDIDATE_BRAND]: true }>;
export type ServerSignaturePrimaryLeaseCandidate = SignatureCandidateFields<PrimaryLeasePayload> &
  Readonly<{ [PRIMARY_LEASE_CANDIDATE_BRAND]: true }>;

export type EdgeSignatureCandidate =
  | ServerSignatureCapabilityTicketCandidate
  | DeviceSignatureExecutionReceiptCandidate
  | ServerSignatureOfflineGrantCandidate
  | ServerSignaturePrimaryLeaseCandidate;

type RegisteredSigner = "server" | "device";
export type EdgeSignatureCandidateKind =
  "capability_ticket" | "execution_receipt" | "offline_grant" | "primary_lease";
type CandidateRegistration = Readonly<{
  signer: RegisteredSigner;
  kind: EdgeSignatureCandidateKind;
}>;

const candidateRegistrations = new WeakMap<object, CandidateRegistration>();

const createSignatureCandidateSchema = <TPayload>(payloadSchema: z.ZodType<TPayload>) =>
  z
    .object({
      protocol_version: SemVerSchema,
      payload: payloadSchema,
      sig: Base64UrlSignatureSchema,
    })
    .strict();

const CapabilityTicketCandidateSchema = createSignatureCandidateSchema(
  CapabilityTicketPayloadSchema,
);
const ExecutionReceiptCandidateSchema = createSignatureCandidateSchema(
  ExecutionReceiptPayloadSchema,
);
const OfflineGrantCandidateSchema = createSignatureCandidateSchema(OfflineGrantPayloadSchema);
const PrimaryLeaseCandidateSchema = createSignatureCandidateSchema(PrimaryLeasePayloadSchema);

const copyAndFreeze = <T>(value: T): DeepReadonly<T> => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => copyAndFreeze(entry))) as DeepReadonly<T>;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, entry]) => [key, copyAndFreeze(entry)]);
    return Object.freeze(Object.fromEntries(entries)) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
};

const registerCandidate = <TCandidate extends object>(
  candidate: TCandidate,
  registration: CandidateRegistration,
): TCandidate => {
  candidateRegistrations.set(candidate, registration);
  return candidate;
};

/**
 * Parses the server-signature line's strict wire shape. A candidate is not cryptographically
 * verified; D2 must verify its detached signature with the configured server public key.
 */
export const parseServerSignatureCapabilityTicketCandidate = (
  value: unknown,
): ServerSignatureCapabilityTicketCandidate =>
  registerCandidate(
    copyAndFreeze(
      CapabilityTicketCandidateSchema.parse(value),
    ) as ServerSignatureCapabilityTicketCandidate,
    { signer: "server", kind: "capability_ticket" },
  );

/**
 * Parses the device-signature line's strict wire shape. A candidate is not cryptographically
 * verified; D2 must verify it with the public key registered to the authenticated device.
 */
export const parseDeviceSignatureExecutionReceiptCandidate = (
  value: unknown,
): DeviceSignatureExecutionReceiptCandidate =>
  registerCandidate(
    copyAndFreeze(
      ExecutionReceiptCandidateSchema.parse(value),
    ) as DeviceSignatureExecutionReceiptCandidate,
    { signer: "device", kind: "execution_receipt" },
  );

/** Parses a server-signature candidate after proving its grant against the complete registry. */
export const parseServerSignatureOfflineGrantCandidate = (
  value: unknown,
  snapshot: OfflineGrantRegistrySnapshot,
): ServerSignatureOfflineGrantCandidate => {
  const parsed = OfflineGrantCandidateSchema.parse(value);
  validateOfflineGrantAllowedCommands(parsed.payload.allowed_commands, snapshot);
  return registerCandidate(copyAndFreeze(parsed) as ServerSignatureOfflineGrantCandidate, {
    signer: "server",
    kind: "offline_grant",
  });
};

/** Parses the exact M0-2 Primary lease wire shape without claiming signature verification. */
export const parseServerSignaturePrimaryLeaseCandidate = (
  value: unknown,
): ServerSignaturePrimaryLeaseCandidate =>
  registerCandidate(
    copyAndFreeze(PrimaryLeaseCandidateSchema.parse(value)) as ServerSignaturePrimaryLeaseCandidate,
    { signer: "server", kind: "primary_lease" },
  );

const hasRegistration = (value: unknown, registration: CandidateRegistration): value is object =>
  typeof value === "object" &&
  value !== null &&
  candidateRegistrations.get(value)?.signer === registration.signer &&
  candidateRegistrations.get(value)?.kind === registration.kind;

export const isServerSignatureCapabilityTicketCandidate = (
  value: unknown,
): value is ServerSignatureCapabilityTicketCandidate =>
  hasRegistration(value, { signer: "server", kind: "capability_ticket" });

export const isDeviceSignatureExecutionReceiptCandidate = (
  value: unknown,
): value is DeviceSignatureExecutionReceiptCandidate =>
  hasRegistration(value, { signer: "device", kind: "execution_receipt" });

export const isServerSignatureOfflineGrantCandidate = (
  value: unknown,
): value is ServerSignatureOfflineGrantCandidate =>
  hasRegistration(value, { signer: "server", kind: "offline_grant" });

export const isServerSignaturePrimaryLeaseCandidate = (
  value: unknown,
): value is ServerSignaturePrimaryLeaseCandidate =>
  hasRegistration(value, { signer: "server", kind: "primary_lease" });

/** @internal Used only to bind a registered candidate to its protocol-specific signing domain. */
export const getSignatureCandidateKind = (value: unknown): EdgeSignatureCandidateKind => {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Signature verification requires a registered candidate");
  }
  const registration = candidateRegistrations.get(value);
  if (registration === undefined) {
    throw new TypeError("Signature verification requires a registered candidate");
  }
  return registration.kind;
};

/** @internal Extracts only the signed authority after checking candidate provenance. */
export const getSignatureCandidateAuthority = (
  value: EdgeSignatureCandidate,
): Readonly<{ protocol_version: string; payload: unknown }> => {
  getSignatureCandidateKind(value);
  return Object.freeze({ protocol_version: value.protocol_version, payload: value.payload });
};
