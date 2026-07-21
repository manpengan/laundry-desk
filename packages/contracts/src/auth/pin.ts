import { z } from "zod";

import { snapshotPlainData } from "./plain-data.js";
import { planSessionFamilyReplacement, type SessionFamilyReplacementPlan } from "./refresh.js";

export const PIN_CHALLENGE_TTL_SECONDS = 120;
export const PIN_CHALLENGE_MAX_ATTEMPTS = 5;
export const STEP_UP_PROOF_TTL_SECONDS = 300;

export const PinSchema = z.string().regex(/^[0-9]{4,8}$/u, "PIN must be 4-8 ASCII digits");

/** Structural C6 result only; C6 remains responsible for verification authority/provenance. */
export const PinVerificationSchema = z.discriminatedUnion("valid", [
  z.strictObject({ valid: z.literal(false) }),
  z.strictObject({ valid: z.literal(true), verified_staff_id: z.uuid() }),
]);

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IncrementableSessionVersionSchema = PositiveSafeIntegerSchema.max(
  Number.MAX_SAFE_INTEGER - 1,
);
const EpochSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ChallengeIssuedAtSchema = EpochSecondsSchema.max(
  Number.MAX_SAFE_INTEGER - PIN_CHALLENGE_TTL_SECONDS,
);
const ProofIssuedAtSchema = EpochSecondsSchema.max(
  Number.MAX_SAFE_INTEGER - STEP_UP_PROOF_TTL_SECONDS,
);
const SafeOpaqueReferenceSchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,256}$/u, "Expected a non-empty visible ASCII reference");
const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u, "Expected lowercase SHA-256 hex");
const EntityTypeSchema = z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u);

const EntityVersionSchema = z.strictObject({
  entity_type: EntityTypeSchema,
  entity_id: z.uuid(),
  version: PositiveSafeIntegerSchema,
});

const EntityVersionsSchema = z
  .array(EntityVersionSchema)
  .refine(
    (versions) =>
      new Set(versions.map((entry) => `${entry.entity_type}\u0000${entry.entity_id}`)).size ===
      versions.length,
    { message: "Entity version identities must be unique" },
  );

const SharedBindingFields = {
  challenge_id: z.uuid(),
  session_id: z.uuid(),
  org_id: z.uuid(),
  store_id: z.uuid(),
  device_id: z.uuid(),
  nonce: z.uuid(),
  issued_at: EpochSecondsSchema,
  expires_at: EpochSecondsSchema,
};

const QuickSwitchFields = {
  ...SharedBindingFields,
  purpose: z.literal("quick_switch"),
  session_version: IncrementableSessionVersionSchema,
  requester_staff_id: z.uuid(),
  target_staff_id: z.uuid(),
};

const StepUpFields = {
  ...SharedBindingFields,
  purpose: z.literal("step_up"),
  session_version: PositiveSafeIntegerSchema,
  pending_action_ref: SafeOpaqueReferenceSchema,
  args_hash: Sha256HexSchema,
  entity_versions: EntityVersionsSchema,
  idempotency_key: z.uuid(),
  requester_staff_id: z.uuid(),
  approver_staff_id: z.uuid(),
};

const addChallengeBindingIssues = (
  binding: Readonly<{
    issued_at: number;
    expires_at: number;
    purpose: "quick_switch" | "step_up";
    requester_staff_id: string;
    approver_staff_id?: string;
  }>,
  context: z.core.$RefinementCtx,
): void => {
  if (binding.expires_at !== binding.issued_at + PIN_CHALLENGE_TTL_SECONDS) {
    context.addIssue({ code: "custom", message: "Challenge TTL must be exactly 120 seconds" });
  }
  if (binding.purpose === "step_up" && binding.approver_staff_id === binding.requester_staff_id) {
    context.addIssue({ code: "custom", message: "Step-up approval must use another staff member" });
  }
};

const QuickSwitchBindingObjectSchema = z.strictObject(QuickSwitchFields);
const StepUpBindingObjectSchema = z.strictObject(StepUpFields);

const PinChallengeBindingSchema = z
  .discriminatedUnion("purpose", [QuickSwitchBindingObjectSchema, StepUpBindingObjectSchema])
  .superRefine(addChallengeBindingIssues);

const ChallengeLifecycleFields = {
  status: z.enum(["active", "consumed"]),
  failed_attempts: z.number().int().nonnegative().max(PIN_CHALLENGE_MAX_ATTEMPTS),
  max_attempts: z.literal(PIN_CHALLENGE_MAX_ATTEMPTS),
};

export const PinChallengeSchema = z
  .discriminatedUnion("purpose", [
    z.strictObject({ ...QuickSwitchFields, ...ChallengeLifecycleFields }),
    z.strictObject({ ...StepUpFields, ...ChallengeLifecycleFields }),
  ])
  .superRefine(addChallengeBindingIssues);

const CreateSharedFields = {
  challenge_id: z.uuid(),
  session_id: z.uuid(),
  org_id: z.uuid(),
  store_id: z.uuid(),
  device_id: z.uuid(),
  nonce: z.uuid(),
  issued_at: ChallengeIssuedAtSchema,
};

const CreatePinChallengeInputSchema = z
  .discriminatedUnion("purpose", [
    z.strictObject({
      ...CreateSharedFields,
      purpose: z.literal("quick_switch"),
      session_version: IncrementableSessionVersionSchema,
      requester_staff_id: z.uuid(),
      target_staff_id: z.uuid(),
    }),
    z.strictObject({
      ...CreateSharedFields,
      purpose: z.literal("step_up"),
      session_version: PositiveSafeIntegerSchema,
      pending_action_ref: SafeOpaqueReferenceSchema,
      args_hash: Sha256HexSchema,
      entity_versions: EntityVersionsSchema,
      idempotency_key: z.uuid(),
      requester_staff_id: z.uuid(),
      approver_staff_id: z.uuid(),
    }),
  ])
  .superRefine((input, context) => {
    if (input.purpose === "step_up" && input.requester_staff_id === input.approver_staff_id) {
      context.addIssue({
        code: "custom",
        message: "Step-up approval must use another staff member",
      });
    }
  });

const StepUpProofObjectSchema = z.strictObject({
  proof_id: z.uuid(),
  status: z.enum(["active", "consumed"]),
  challenge_binding: StepUpBindingObjectSchema,
  issued_at: EpochSecondsSchema,
  expires_at: EpochSecondsSchema,
});

export const StepUpProofSchema = StepUpProofObjectSchema.superRefine((proof, context) => {
  addChallengeBindingIssues(proof.challenge_binding, context);
  if (proof.expires_at !== proof.issued_at + STEP_UP_PROOF_TTL_SECONDS) {
    context.addIssue({ code: "custom", message: "Step-up proof TTL must be exactly 300 seconds" });
  }
  if (
    proof.issued_at < proof.challenge_binding.issued_at ||
    proof.issued_at >= proof.challenge_binding.expires_at
  ) {
    context.addIssue({
      code: "custom",
      message: "Step-up proof must be issued while its challenge is active",
    });
  }
});

export type PinChallenge = DeepReadonly<z.output<typeof PinChallengeSchema>>;
export type StepUpProof = DeepReadonly<z.output<typeof StepUpProofSchema>>;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreeze(entry))) as DeepReadonly<T>;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)]);
    return Object.freeze(Object.fromEntries(entries)) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
};

const parseSnapshot = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> => schema.parse(snapshotPlainData(input, label));

/** Creates a server-bound challenge; raw PIN values are never accepted here. */
export const createPinChallenge = (input: unknown): PinChallenge => {
  const binding = parseSnapshot(CreatePinChallengeInputSchema, input, "PIN challenge input");
  return deepFreeze({
    ...binding,
    expires_at: binding.issued_at + PIN_CHALLENGE_TTL_SECONDS,
    status: "active" as const,
    failed_attempts: 0,
    max_attempts: PIN_CHALLENGE_MAX_ATTEMPTS,
  });
};

export type PinAttemptRejectionReason =
  | "PURPOSE_MISMATCH"
  | "CHALLENGE_BINDING_MISMATCH"
  | "CHALLENGE_NOT_ACTIVE"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_CONSUMED"
  | "CHALLENGE_EXHAUSTED"
  | "PIN_PRINCIPAL_MISMATCH"
  | "REPLACEMENT_IDENTITIES_REUSED";

type RejectedAttempt = Readonly<{ kind: "reject"; reason: PinAttemptRejectionReason }>;
type ChallengeCasCompare = Readonly<{
  challenge_id: string;
  status: "active";
  failed_attempts: number;
}>;
type FailurePlan = DeepReadonly<{
  kind: "record_failure";
  compare: ChallengeCasCompare;
  effects: {
    next_failed_attempts: number;
    challenge_exhausted: boolean;
  };
}>;

export type QuickSwitchAttemptPlan =
  | RejectedAttempt
  | FailurePlan
  | DeepReadonly<{
      kind: "quick_switch_success";
      compare: ChallengeCasCompare;
      atomic_effects: {
        consume_challenge: true;
        next_actor_staff_id: string;
        actor_change_mode: "replacement_session_only";
        replacement: SessionFamilyReplacementPlan;
      };
    }>;

export type StepUpAttemptPlan =
  | RejectedAttempt
  | FailurePlan
  | DeepReadonly<{
      kind: "step_up_success";
      compare: ChallengeCasCompare;
      atomic_effects: {
        consume_challenge: true;
        actor_effect: "unchanged";
        session_effect: "unchanged";
        proof: StepUpProof;
      };
    }>;

const rejectAttempt = (reason: PinAttemptRejectionReason): RejectedAttempt =>
  Object.freeze({ kind: "reject", reason });

const challengeCompare = (challenge: PinChallenge): ChallengeCasCompare =>
  Object.freeze({
    challenge_id: challenge.challenge_id,
    status: "active",
    failed_attempts: challenge.failed_attempts,
  });

const planFailure = (challenge: PinChallenge): FailurePlan => {
  const nextFailedAttempts = challenge.failed_attempts + 1;
  return deepFreeze({
    kind: "record_failure",
    compare: challengeCompare(challenge),
    effects: {
      next_failed_attempts: nextFailedAttempts,
      challenge_exhausted: nextFailedAttempts === PIN_CHALLENGE_MAX_ATTEMPTS,
    },
  });
};

const entityVersionsMatch = (
  left: readonly z.output<typeof EntityVersionSchema>[],
  right: readonly z.output<typeof EntityVersionSchema>[],
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      entry.entity_type === candidate.entity_type &&
      entry.entity_id === candidate.entity_id &&
      entry.version === candidate.version
    );
  });

const sharedBindingMatches = (
  challenge: DeepReadonly<z.output<typeof PinChallengeBindingSchema>>,
  binding: z.output<typeof PinChallengeBindingSchema>,
): boolean =>
  challenge.challenge_id === binding.challenge_id &&
  challenge.session_id === binding.session_id &&
  challenge.session_version === binding.session_version &&
  challenge.org_id === binding.org_id &&
  challenge.store_id === binding.store_id &&
  challenge.device_id === binding.device_id &&
  challenge.purpose === binding.purpose &&
  challenge.nonce === binding.nonce &&
  challenge.issued_at === binding.issued_at &&
  challenge.expires_at === binding.expires_at;

const quickBindingMatches = (
  challenge: Extract<PinChallenge, { purpose: "quick_switch" }>,
  binding: z.output<typeof QuickSwitchBindingObjectSchema>,
): boolean =>
  sharedBindingMatches(challenge, binding) &&
  challenge.requester_staff_id === binding.requester_staff_id &&
  challenge.target_staff_id === binding.target_staff_id;

const stepUpBindingMatches = (
  challenge: DeepReadonly<z.output<typeof StepUpBindingObjectSchema>>,
  binding: z.output<typeof StepUpBindingObjectSchema>,
): boolean =>
  sharedBindingMatches(challenge, binding) &&
  challenge.pending_action_ref === binding.pending_action_ref &&
  challenge.args_hash === binding.args_hash &&
  entityVersionsMatch(challenge.entity_versions, binding.entity_versions) &&
  challenge.idempotency_key === binding.idempotency_key &&
  challenge.requester_staff_id === binding.requester_staff_id &&
  challenge.approver_staff_id === binding.approver_staff_id;

const challengeStateRejection = (
  challenge: PinChallenge,
  nowEpochSeconds: number,
): PinAttemptRejectionReason | undefined => {
  if (challenge.status === "consumed") return "CHALLENGE_CONSUMED";
  if (challenge.failed_attempts >= PIN_CHALLENGE_MAX_ATTEMPTS) return "CHALLENGE_EXHAUSTED";
  if (nowEpochSeconds < challenge.issued_at) return "CHALLENGE_NOT_ACTIVE";
  if (nowEpochSeconds >= challenge.expires_at) return "CHALLENGE_EXPIRED";
  return undefined;
};

const QuickSwitchAttemptInputSchema = z.strictObject({
  challenge: PinChallengeSchema,
  current_binding: PinChallengeBindingSchema,
  now_epoch_seconds: EpochSecondsSchema,
  pin_verification: PinVerificationSchema,
  previous_session_id: z.uuid(),
  previous_family_id: z.uuid(),
  next_session_id: z.uuid(),
  next_family_id: z.uuid(),
});

/** Produces compare/effects that C6 must execute in one transaction; it receives no raw PIN. */
export const planQuickSwitchAttempt = (input: unknown): QuickSwitchAttemptPlan => {
  const facts = parseSnapshot(QuickSwitchAttemptInputSchema, input, "quick-switch attempt facts");
  if (
    facts.challenge.purpose !== "quick_switch" ||
    facts.current_binding.purpose !== "quick_switch"
  ) {
    return rejectAttempt("PURPOSE_MISMATCH");
  }
  if (
    !quickBindingMatches(facts.challenge, facts.current_binding) ||
    facts.previous_session_id !== facts.challenge.session_id
  ) {
    return rejectAttempt("CHALLENGE_BINDING_MISMATCH");
  }
  const stateRejection = challengeStateRejection(facts.challenge, facts.now_epoch_seconds);
  if (stateRejection !== undefined) return rejectAttempt(stateRejection);
  if (!facts.pin_verification.valid) return planFailure(facts.challenge);
  if (facts.pin_verification.verified_staff_id !== facts.challenge.target_staff_id) {
    return rejectAttempt("PIN_PRINCIPAL_MISMATCH");
  }
  if (
    facts.next_session_id === facts.previous_session_id ||
    facts.next_family_id === facts.previous_family_id
  ) {
    return rejectAttempt("REPLACEMENT_IDENTITIES_REUSED");
  }

  const replacement = planSessionFamilyReplacement({
    cause: "pin_switch",
    previous_session_id: facts.previous_session_id,
    previous_family_id: facts.previous_family_id,
    previous_session_version: facts.challenge.session_version,
    next_session_id: facts.next_session_id,
    next_family_id: facts.next_family_id,
  });
  return deepFreeze({
    kind: "quick_switch_success" as const,
    compare: challengeCompare(facts.challenge),
    atomic_effects: {
      consume_challenge: true as const,
      next_actor_staff_id: facts.challenge.target_staff_id,
      actor_change_mode: "replacement_session_only" as const,
      replacement,
    },
  });
};

const StepUpAttemptInputSchema = z.strictObject({
  challenge: PinChallengeSchema,
  current_binding: PinChallengeBindingSchema,
  now_epoch_seconds: ProofIssuedAtSchema,
  pin_verification: PinVerificationSchema,
  proof_id: z.uuid(),
});

const copyStepUpBinding = (
  challenge: Extract<PinChallenge, { purpose: "step_up" }>,
): z.output<typeof StepUpBindingObjectSchema> => ({
  purpose: challenge.purpose,
  challenge_id: challenge.challenge_id,
  session_id: challenge.session_id,
  session_version: challenge.session_version,
  org_id: challenge.org_id,
  store_id: challenge.store_id,
  device_id: challenge.device_id,
  nonce: challenge.nonce,
  issued_at: challenge.issued_at,
  expires_at: challenge.expires_at,
  pending_action_ref: challenge.pending_action_ref,
  args_hash: challenge.args_hash,
  entity_versions: challenge.entity_versions.map((entry) => ({ ...entry })),
  idempotency_key: challenge.idempotency_key,
  requester_staff_id: challenge.requester_staff_id,
  approver_staff_id: challenge.approver_staff_id,
});

/** Produces compare/effects that C6 must execute in one transaction without switching actor. */
export const planStepUpAttempt = (input: unknown): StepUpAttemptPlan => {
  const facts = parseSnapshot(StepUpAttemptInputSchema, input, "step-up attempt facts");
  if (facts.challenge.purpose !== "step_up" || facts.current_binding.purpose !== "step_up") {
    return rejectAttempt("PURPOSE_MISMATCH");
  }
  if (!stepUpBindingMatches(facts.challenge, facts.current_binding)) {
    return rejectAttempt("CHALLENGE_BINDING_MISMATCH");
  }
  const stateRejection = challengeStateRejection(facts.challenge, facts.now_epoch_seconds);
  if (stateRejection !== undefined) return rejectAttempt(stateRejection);
  if (!facts.pin_verification.valid) return planFailure(facts.challenge);
  if (facts.pin_verification.verified_staff_id !== facts.challenge.approver_staff_id) {
    return rejectAttempt("PIN_PRINCIPAL_MISMATCH");
  }

  return deepFreeze({
    kind: "step_up_success" as const,
    compare: challengeCompare(facts.challenge),
    atomic_effects: {
      consume_challenge: true as const,
      actor_effect: "unchanged" as const,
      session_effect: "unchanged" as const,
      proof: {
        proof_id: facts.proof_id,
        status: "active" as const,
        challenge_binding: copyStepUpBinding(facts.challenge),
        issued_at: facts.now_epoch_seconds,
        expires_at: facts.now_epoch_seconds + STEP_UP_PROOF_TTL_SECONDS,
      },
    },
  });
};

export type StepUpProofDecision =
  | Readonly<{
      kind: "reject";
      reason: "PROOF_BINDING_MISMATCH" | "PROOF_NOT_ACTIVE" | "PROOF_EXPIRED" | "PROOF_CONSUMED";
    }>
  | DeepReadonly<{
      kind: "consume_step_up_proof";
      compare: { proof_id: string; status: "active" };
      atomic_effects: {
        consume_proof: true;
        current_actor_staff_id: string;
        current_session_id: string;
        actor_effect: "unchanged";
        session_effect: "unchanged";
      };
    }>;

export type SingleUseCasCommitDisposition =
  Readonly<{ kind: "committed" }> | Readonly<{ kind: "stale"; action: "reload_and_reject" }>;

const SingleUseCasCommitInputSchema = z.strictObject({
  matched_rows: z.union([z.literal(0), z.literal(1)]),
});

/** Classifies the C6/C5 database CAS result; it does not provide database atomicity itself. */
export const classifySingleUseCasCommit = (input: unknown): SingleUseCasCommitDisposition => {
  const facts = parseSnapshot(SingleUseCasCommitInputSchema, input, "single-use CAS result");
  return facts.matched_rows === 1
    ? Object.freeze({ kind: "committed" })
    : Object.freeze({ kind: "stale", action: "reload_and_reject" });
};

const EvaluateStepUpProofInputSchema = z.strictObject({
  proof: StepUpProofSchema,
  expected_binding: StepUpBindingObjectSchema.superRefine(addChallengeBindingIssues),
  current_actor_staff_id: z.uuid(),
  current_session_id: z.uuid(),
  now_epoch_seconds: EpochSecondsSchema,
});

const rejectProof = (
  reason: Extract<StepUpProofDecision, { kind: "reject" }>["reason"],
): StepUpProofDecision => Object.freeze({ kind: "reject", reason });

/** Classifies C5's exact, single-use proof consumption precondition. */
export const evaluateStepUpProof = (input: unknown): StepUpProofDecision => {
  const facts = parseSnapshot(EvaluateStepUpProofInputSchema, input, "step-up proof facts");
  const binding = facts.proof.challenge_binding;
  if (
    !stepUpBindingMatches(binding, facts.expected_binding) ||
    facts.current_actor_staff_id !== binding.requester_staff_id ||
    facts.current_session_id !== binding.session_id
  ) {
    return rejectProof("PROOF_BINDING_MISMATCH");
  }
  if (facts.proof.status === "consumed") return rejectProof("PROOF_CONSUMED");
  if (facts.now_epoch_seconds < facts.proof.issued_at) return rejectProof("PROOF_NOT_ACTIVE");
  if (facts.now_epoch_seconds >= facts.proof.expires_at) return rejectProof("PROOF_EXPIRED");

  return deepFreeze({
    kind: "consume_step_up_proof",
    compare: { proof_id: facts.proof.proof_id, status: "active" as const },
    atomic_effects: {
      consume_proof: true as const,
      current_actor_staff_id: facts.current_actor_staff_id,
      current_session_id: facts.current_session_id,
      actor_effect: "unchanged" as const,
      session_effect: "unchanged" as const,
    },
  });
};
