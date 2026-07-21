import { z } from "zod";

import { CommandWirePayloadSchema, type CommandWirePayload } from "../envelope/wire-payload.js";
import { PositiveSafeIntegerSchema } from "../registry/limits.js";
import { ExactUtcTimestampSchema } from "./primitives.js";

const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const GrantQueueAuthorizationSchema = z
  .object({
    kind: z.literal("grant"),
    grant_id: z.uuid(),
  })
  .strict();

const PrimaryLeaseQueueAuthorizationSchema = z
  .object({
    kind: z.literal("primary_lease"),
    grant_id: z.uuid(),
    lease_id: z.uuid(),
    primary_epoch: PositiveSafeIntegerSchema,
    per_lease_seq: PositiveSafeIntegerSchema,
  })
  .strict();

export const QueueAuthorizationSchema = z.discriminatedUnion("kind", [
  GrantQueueAuthorizationSchema,
  PrimaryLeaseQueueAuthorizationSchema,
]);

/**
 * ADR-04 #7: A4 exclusively owns the replay tuple. It supports idempotency, replay rejection,
 * ordering and audit attribution; it does not claim to prevent physical double delivery.
 */
const EdgeQueueEnvelopeSchema = z
  .object({
    /** Independently versioned from the contracts protocol major. */
    queue_envelope_version: PositiveSafeIntegerSchema,
    /** Compatibility unit used by the server's current/previous contracts-major window. */
    contracts_major: NonNegativeSafeIntegerSchema,
    queue_id: z.uuid(),
    enqueued_at: ExactUtcTimestampSchema,
    /** A2 carries no caller-reported actor or tenant; C8 injects authenticated server context. */
    payload: CommandWirePayloadSchema,
    authorization: QueueAuthorizationSchema,
  })
  .strict();

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

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

export type QueueAuthorization = DeepReadonly<z.output<typeof QueueAuthorizationSchema>>;
export type EdgeQueueEnvelope = Readonly<{
  queue_envelope_version: number;
  contracts_major: number;
  queue_id: string;
  enqueued_at: string;
  payload: DeepReadonly<CommandWirePayload>;
  authorization: QueueAuthorization;
}>;

/** Parses one immutable A4 envelope; tenant/actor identity is intentionally not accepted. */
export const parseEdgeQueueEnvelope = (value: unknown): EdgeQueueEnvelope =>
  copyAndFreeze(EdgeQueueEnvelopeSchema.parse(value)) as EdgeQueueEnvelope;

const QueueEnvelopeCompatibilityPolicySchema = z
  .object({
    minimum_secure_queue_version: PositiveSafeIntegerSchema,
    current_queue_version: PositiveSafeIntegerSchema,
    current_contracts_major: NonNegativeSafeIntegerSchema,
  })
  .strict()
  .refine((policy) => policy.minimum_secure_queue_version <= policy.current_queue_version, {
    message: "Minimum secure queue version may not exceed the current version",
    path: ["minimum_secure_queue_version"],
  });

export type QueueEnvelopeVersionDisposition =
  | Readonly<{ mode: "replay"; automatic_replay: true }>
  | Readonly<{ mode: "recover_to_arbitration"; automatic_replay: false }>
  | Readonly<{ mode: "read_only_recovery"; automatic_replay: false }>;

/**
 * ADR-08 rollback gate. The actual parsed envelope and both compatibility dimensions are decided
 * atomically, so a caller cannot classify one version and replay a different payload.
 */
export const classifyQueueEnvelopeCompatibility = (
  envelopeInput: unknown,
  policyInput: unknown,
): QueueEnvelopeVersionDisposition => {
  const envelope = parseEdgeQueueEnvelope(envelopeInput);
  const policy = QueueEnvelopeCompatibilityPolicySchema.parse(policyInput);
  const previousContractsMajor = Math.max(0, policy.current_contracts_major - 1);

  if (
    envelope.queue_envelope_version < policy.minimum_secure_queue_version ||
    envelope.contracts_major < previousContractsMajor
  ) {
    return Object.freeze({ mode: "recover_to_arbitration", automatic_replay: false });
  }
  if (
    envelope.queue_envelope_version > policy.current_queue_version ||
    envelope.contracts_major > policy.current_contracts_major
  ) {
    return Object.freeze({ mode: "read_only_recovery", automatic_replay: false });
  }
  return Object.freeze({ mode: "replay", automatic_replay: true });
};
