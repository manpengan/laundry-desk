import { z } from "zod";

import { SemVerSchema } from "../registry/primitives.js";
import {
  type OfflineGrantRegistrySnapshot,
  validateOfflineGrantAllowedCommands,
} from "./offline-grant.js";
import {
  CapabilityTicketPayloadSchema,
  ExecutionReceiptPayloadSchema,
  OfflineGrantPayloadSchema,
  PrimaryLeasePayloadSchema,
} from "./protocols.js";
import {
  getSignatureCandidateAuthority,
  getSignatureCandidateKind,
  type EdgeSignatureCandidate,
  type EdgeSignatureCandidateKind,
} from "./signed-envelope.js";

const SIGNING_DOMAINS = Object.freeze({
  capability_ticket: "laundry.edge.capability-ticket.v1",
  execution_receipt: "laundry.edge.execution-receipt.v1",
  offline_grant: "laundry.edge.offline-grant.v1",
  primary_lease: "laundry.edge.primary-lease.v1",
} satisfies Readonly<Record<EdgeSignatureCandidateKind, string>>);

const textEncoder = new TextEncoder();

const isPlainRecord = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const compareCanonicalKeys = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const serializeCanonicalNumber = (value: number): string => {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new TypeError("Canonical numbers must be non-negative-zero safe integers");
  }
  return String(value);
};

const serializeCanonicalArray = (value: readonly unknown[], ancestors: WeakSet<object>): string => {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    throw new TypeError("Canonical arrays must be dense and contain no extra properties");
  }
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Canonical arrays must be dense data properties");
    }
    entries.push(serializeCanonicalValue(descriptor.value, ancestors));
  }
  return `[${entries.join(",")}]`;
};

const serializeCanonicalRecord = (value: object, ancestors: WeakSet<object>): string => {
  const entries = Reflect.ownKeys(value)
    .map((key): readonly [string, unknown] => {
      if (typeof key !== "string") {
        throw new TypeError("Canonical records may not have symbol keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new TypeError("Canonical records may not have accessors");
      }
      return [key, descriptor.value];
    })
    .sort(([left], [right]) => compareCanonicalKeys(left, right));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${serializeCanonicalValue(entry, ancestors)}`)
    .join(",")}}`;
};

const serializeCanonicalValue = (value: unknown, ancestors: WeakSet<object>): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return serializeCanonicalNumber(value);
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Canonical values must be acyclic JSON values");
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new TypeError("Canonical objects must be plain records");
  }
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeCanonicalArray(value, ancestors)
      : serializeCanonicalRecord(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
};

function assertExactAuthorityShape(authority: unknown): asserts authority is Readonly<{
  protocol_version: unknown;
  payload: unknown;
}> {
  if (typeof authority !== "object" || authority === null || !isPlainRecord(authority)) {
    throw new TypeError("Signed authority must be a plain record");
  }
  const keys = Reflect.ownKeys(authority);
  if (keys.length !== 2 || !keys.includes("protocol_version") || !keys.includes("payload")) {
    throw new TypeError("Signed authority must contain only protocol_version and payload");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(authority, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("Signed authority fields must be data properties");
    }
  }
}

const canonicalizeAuthority = (domain: string, authority: unknown): Uint8Array => {
  if (domain.length === 0 || domain.includes("\n")) {
    throw new TypeError("Signing domain must be a non-empty single line");
  }
  assertExactAuthorityShape(authority);
  return textEncoder.encode(
    `${domain}\n${serializeCanonicalValue(authority, new WeakSet<object>())}`,
  );
};

const createAuthoritySchema = <TPayload>(payloadSchema: z.ZodType<TPayload>) =>
  z.object({ protocol_version: SemVerSchema, payload: payloadSchema }).strict();

const CapabilityTicketAuthoritySchema = createAuthoritySchema(CapabilityTicketPayloadSchema);
const ExecutionReceiptAuthoritySchema = createAuthoritySchema(ExecutionReceiptPayloadSchema);
const OfflineGrantAuthoritySchema = createAuthoritySchema(OfflineGrantPayloadSchema);
const PrimaryLeaseAuthoritySchema = createAuthoritySchema(PrimaryLeasePayloadSchema);

/** Canonical server signing bytes for one strictly parsed capability-ticket authority. */
export const canonicalizeCapabilityTicketForSigning = (authority: unknown): Uint8Array =>
  canonicalizeAuthority(
    SIGNING_DOMAINS.capability_ticket,
    CapabilityTicketAuthoritySchema.parse(authority),
  );

/** Canonical device signing bytes for one strictly parsed execution-receipt authority. */
export const canonicalizeExecutionReceiptForSigning = (authority: unknown): Uint8Array =>
  canonicalizeAuthority(
    SIGNING_DOMAINS.execution_receipt,
    ExecutionReceiptAuthoritySchema.parse(authority),
  );

/** Canonical server signing bytes for a grant proven against the complete registry snapshot. */
export const canonicalizeOfflineGrantForSigning = (
  authorityInput: unknown,
  snapshot: OfflineGrantRegistrySnapshot,
): Uint8Array => {
  const authority = OfflineGrantAuthoritySchema.parse(authorityInput);
  validateOfflineGrantAllowedCommands(authority.payload.allowed_commands, snapshot);
  return canonicalizeAuthority(SIGNING_DOMAINS.offline_grant, authority);
};

/** Canonical server signing bytes for one strictly parsed Primary lease authority. */
export const canonicalizePrimaryLeaseForSigning = (authority: unknown): Uint8Array =>
  canonicalizeAuthority(
    SIGNING_DOMAINS.primary_lease,
    PrimaryLeaseAuthoritySchema.parse(authority),
  );

/**
 * Produces verification bytes only for a provenance-registered signature candidate. Registration
 * proves strict wire parsing and signer direction, not cryptographic validity.
 */
export const canonicalizeForSignatureVerification = (
  candidate: EdgeSignatureCandidate,
): Uint8Array => {
  const kind = getSignatureCandidateKind(candidate);
  return canonicalizeAuthority(SIGNING_DOMAINS[kind], getSignatureCandidateAuthority(candidate));
};

/** @internal Test seam for the canonical serializer; not exported from the package entry point. */
export const canonicalizeAuthorityForTest = (domain: string, authority: unknown): Uint8Array =>
  canonicalizeAuthority(domain, authority);
