import { describe, expect, it } from "vitest";

import {
  PIN_CHALLENGE_MAX_ATTEMPTS,
  PIN_CHALLENGE_TTL_SECONDS,
  STEP_UP_PROOF_TTL_SECONDS,
  PinChallengeSchema,
  PinSchema,
  StepUpProofSchema,
  createPinChallenge,
  evaluateStepUpProof,
  planQuickSwitchAttempt,
  planStepUpAttempt,
} from "../src/auth/pin.js";

const ids = {
  challenge: "de37efb9-6631-414b-ae76-6407af5d5e0f",
  session: "1131e8c3-b7e3-4633-8af8-a5e3286570e1",
  otherSession: "45661384-8444-4104-bbb8-35ea6e824035",
  family: "8aef4f00-d823-4e76-90f5-e03070905d92",
  nextSession: "7bb79d86-dc5c-47de-9218-d503ed3c9efb",
  nextFamily: "66e54d2c-e99e-49f8-8f1d-d3d2f363394e",
  org: "7fc08781-28b3-4c87-bf7b-259c0c0d3aec",
  store: "a9e42cdd-df10-4b72-b06e-a6b66937945e",
  device: "01a2eed0-a6c3-493c-a3a7-20bf94b1d678",
  nonce: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
  requester: "d5a92f5a-653a-4b06-b014-e4a5e0d91f0c",
  target: "aa1abbb4-e3af-4718-b1e2-231f4c450971",
  approver: "fa069359-d900-442d-b10b-3478e37f7156",
  proof: "fdbd1a32-7ee3-4d28-a6ab-923b22c0fe99",
  idempotency: "6e6eaf00-417f-44c9-9ba2-c7b01c4dfe91",
  entityOne: "752e85f2-d726-4530-ae63-110f2db3682b",
  entityTwo: "87e0ce97-1179-42d7-8332-d3f41d76d3a4",
} as const;

const ISSUED_AT = 1_800_000_000;
const ACTIVE_NOW = ISSUED_AT + 30;

const entityVersions = [
  { entity_type: "orders.order", entity_id: ids.entityOne, version: 3 },
  { entity_type: "payments.payment", entity_id: ids.entityTwo, version: 7 },
];

const quickChallengeInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  purpose: "quick_switch",
  challenge_id: ids.challenge,
  session_id: ids.session,
  session_version: 4,
  org_id: ids.org,
  store_id: ids.store,
  device_id: ids.device,
  nonce: ids.nonce,
  issued_at: ISSUED_AT,
  requester_staff_id: ids.requester,
  target_staff_id: ids.target,
  ...overrides,
});

const stepUpChallengeInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  purpose: "step_up",
  challenge_id: ids.challenge,
  session_id: ids.session,
  session_version: 4,
  org_id: ids.org,
  store_id: ids.store,
  device_id: ids.device,
  nonce: ids.nonce,
  issued_at: ISSUED_AT,
  pending_action_ref: "command:orders.refund:pending-01",
  args_hash: "a".repeat(64),
  entity_versions: entityVersions.map((entry) => ({ ...entry })),
  idempotency_key: ids.idempotency,
  requester_staff_id: ids.requester,
  approver_staff_id: ids.approver,
  ...overrides,
});

const quickBinding = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  ...quickChallengeInput(),
  expires_at: ISSUED_AT + PIN_CHALLENGE_TTL_SECONDS,
  ...overrides,
});

const stepUpBinding = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  ...stepUpChallengeInput(),
  expires_at: ISSUED_AT + PIN_CHALLENGE_TTL_SECONDS,
  ...overrides,
});

const quickAttemptInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  challenge: createPinChallenge(quickChallengeInput()),
  current_binding: quickBinding(),
  now_epoch_seconds: ACTIVE_NOW,
  pin_valid: true,
  previous_session_id: ids.session,
  previous_family_id: ids.family,
  next_session_id: ids.nextSession,
  next_family_id: ids.nextFamily,
  ...overrides,
});

const stepUpAttemptInput = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  challenge: createPinChallenge(stepUpChallengeInput()),
  current_binding: stepUpBinding(),
  now_epoch_seconds: ACTIVE_NOW,
  pin_valid: true,
  proof_id: ids.proof,
  ...overrides,
});

const expectDeepFrozen = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach((entry) => expectDeepFrozen(entry, seen));
};

const unstableProxy = <T extends object>(input: T, unstableKey: keyof T): T => {
  let reads = 0;
  return new Proxy(input, {
    getOwnPropertyDescriptor(target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (property !== unstableKey || descriptor === undefined || !("value" in descriptor)) {
        return descriptor;
      }
      reads += 1;
      return reads === 1
        ? descriptor
        : { ...descriptor, value: `${String(descriptor.value)}-changed` };
    },
  });
};

describe("A5 PIN raw request schema", () => {
  it("accepts only 4 through 8 unmodified ASCII digits", () => {
    expect(PinSchema.parse("0012")).toBe("0012");
    expect(PinSchema.parse("12345678")).toBe("12345678");

    [
      "123",
      "123456789",
      "１２３４",
      "123a",
      " 1234",
      "1234 ",
      "12\n34",
      1234,
      new String("1234"),
    ].forEach((candidate) => expect(() => PinSchema.parse(candidate)).toThrow());
  });
});

describe("A5 PIN challenge factory", () => {
  it("freezes exact challenge lifetime and attempt constants", () => {
    expect(PIN_CHALLENGE_TTL_SECONDS).toBe(120);
    expect(PIN_CHALLENGE_MAX_ATTEMPTS).toBe(5);
    expect(STEP_UP_PROOF_TTL_SECONDS).toBe(300);
  });

  it("creates an immutable quick-switch challenge with exact 120-second TTL", () => {
    const input = quickChallengeInput();
    const challenge = createPinChallenge(input);

    expect(challenge).toEqual({
      ...quickBinding(),
      status: "active",
      failed_attempts: 0,
      max_attempts: 5,
    });
    expect(input).toEqual(quickChallengeInput());
    expectDeepFrozen(challenge);
    expect(PinChallengeSchema.parse(challenge)).toEqual(challenge);
  });

  it("creates an immutable step-up challenge with exact action binding", () => {
    const challenge = createPinChallenge(stepUpChallengeInput());

    expect(challenge).toEqual({
      ...stepUpBinding(),
      status: "active",
      failed_attempts: 0,
      max_attempts: 5,
    });
    expectDeepFrozen(challenge);
    expect(PinChallengeSchema.parse(challenge)).toEqual(challenge);
  });

  it("keeps quick-switch and step-up fields as strict discriminated branches", () => {
    expect(() =>
      createPinChallenge({ ...quickChallengeInput(), pending_action_ref: "command:bad" }),
    ).toThrow();
    expect(() =>
      createPinChallenge({ ...stepUpChallengeInput(), target_staff_id: ids.target }),
    ).toThrow();
    expect(() => createPinChallenge({ ...stepUpChallengeInput(), args_hash: undefined })).toThrow();
  });

  it("rejects self-approval, malformed hashes and duplicate entity identities", () => {
    expect(() =>
      createPinChallenge(stepUpChallengeInput({ approver_staff_id: ids.requester })),
    ).toThrow();
    expect(() => createPinChallenge(stepUpChallengeInput({ args_hash: "A".repeat(64) }))).toThrow();
    expect(() => createPinChallenge(stepUpChallengeInput({ args_hash: "a".repeat(63) }))).toThrow();
    expect(() =>
      createPinChallenge(
        stepUpChallengeInput({
          entity_versions: [entityVersions[0], { ...entityVersions[0], version: 4 }],
        }),
      ),
    ).toThrow();
  });

  it("rejects challenge time overflow and records with a non-exact TTL", () => {
    expect(() =>
      createPinChallenge(quickChallengeInput({ issued_at: Number.MAX_SAFE_INTEGER - 119 })),
    ).toThrow();
    expect(() =>
      PinChallengeSchema.parse({
        ...createPinChallenge(quickChallengeInput()),
        expires_at: ISSUED_AT + 121,
      }),
    ).toThrow();
  });
});

describe("A5 quick-switch attempt planning", () => {
  it("reuses the revoke-before-create replacement plan and changes actor only in the new session", () => {
    const input = quickAttemptInput();
    const plan = planQuickSwitchAttempt(input);

    expect(plan).toEqual({
      kind: "quick_switch_success",
      consume_challenge: true,
      next_actor_staff_id: ids.target,
      actor_change_mode: "replacement_session_only",
      replacement: {
        kind: "replace_session_family",
        cause: "pin_switch",
        steps: [
          {
            order: 1,
            action: "revoke_previous",
            session_id: ids.session,
            family_id: ids.family,
            next_session_version: 5,
          },
          {
            order: 2,
            action: "create_replacement",
            session_id: ids.nextSession,
            family_id: ids.nextFamily,
          },
        ],
      },
    });
    expect(input).toEqual(quickAttemptInput());
    expectDeepFrozen(plan);
  });

  it("increments failures and makes the fifth failure explicitly exhausted", () => {
    expect(planQuickSwitchAttempt(quickAttemptInput({ pin_valid: false }))).toEqual({
      kind: "record_failure",
      challenge_id: ids.challenge,
      next_failed_attempts: 1,
      challenge_exhausted: false,
    });
    expect(
      planQuickSwitchAttempt(
        quickAttemptInput({
          challenge: {
            ...createPinChallenge(quickChallengeInput()),
            failed_attempts: 4,
          },
          pin_valid: false,
        }),
      ),
    ).toEqual({
      kind: "record_failure",
      challenge_id: ids.challenge,
      next_failed_attempts: 5,
      challenge_exhausted: true,
    });
  });

  it.each([true, false])("rejects every attempt after five failures (pin_valid=%s)", (pinValid) => {
    const plan = planQuickSwitchAttempt(
      quickAttemptInput({
        challenge: {
          ...createPinChallenge(quickChallengeInput()),
          failed_attempts: 5,
        },
        pin_valid: pinValid,
      }),
    );
    expect(plan).toEqual({ kind: "reject", reason: "CHALLENGE_EXHAUSTED" });
  });

  it("rejects expired, not-yet-active and consumed challenges", () => {
    expect(
      planQuickSwitchAttempt(
        quickAttemptInput({ now_epoch_seconds: ISSUED_AT + PIN_CHALLENGE_TTL_SECONDS }),
      ),
    ).toEqual({ kind: "reject", reason: "CHALLENGE_EXPIRED" });
    expect(planQuickSwitchAttempt(quickAttemptInput({ now_epoch_seconds: ISSUED_AT - 1 }))).toEqual(
      {
        kind: "reject",
        reason: "CHALLENGE_NOT_ACTIVE",
      },
    );
    expect(
      planQuickSwitchAttempt(
        quickAttemptInput({
          challenge: { ...createPinChallenge(quickChallengeInput()), status: "consumed" },
        }),
      ),
    ).toEqual({ kind: "reject", reason: "CHALLENGE_CONSUMED" });
  });

  it("rejects purpose mismatch, previous-session mismatch and reused replacement identities", () => {
    expect(
      planQuickSwitchAttempt(
        quickAttemptInput({
          challenge: createPinChallenge(stepUpChallengeInput()),
          current_binding: stepUpBinding(),
        }),
      ),
    ).toEqual({ kind: "reject", reason: "PURPOSE_MISMATCH" });
    expect(
      planQuickSwitchAttempt(quickAttemptInput({ previous_session_id: ids.otherSession })),
    ).toEqual({ kind: "reject", reason: "CHALLENGE_BINDING_MISMATCH" });
    expect(planQuickSwitchAttempt(quickAttemptInput({ next_session_id: ids.session }))).toEqual({
      kind: "reject",
      reason: "REPLACEMENT_IDENTITIES_REUSED",
    });
    expect(planQuickSwitchAttempt(quickAttemptInput({ next_family_id: ids.family }))).toEqual({
      kind: "reject",
      reason: "REPLACEMENT_IDENTITIES_REUSED",
    });
  });

  it.each([
    { challenge_id: ids.proof },
    { session_id: ids.otherSession },
    { session_version: 5 },
    { org_id: ids.store },
    { store_id: ids.org },
    { device_id: ids.nextSession },
    { nonce: ids.proof },
    { issued_at: ISSUED_AT + 1, expires_at: ISSUED_AT + 121 },
    { requester_staff_id: ids.approver },
    { target_staff_id: ids.approver },
  ])("rejects changed quick binding $s", (bindingOverride) => {
    expect(
      planQuickSwitchAttempt(quickAttemptInput({ current_binding: quickBinding(bindingOverride) })),
    ).toEqual({ kind: "reject", reason: "CHALLENGE_BINDING_MISMATCH" });
  });
});

describe("A5 step-up attempt and proof", () => {
  it("issues a five-minute proof copied from the challenge without changing actor or session", () => {
    const plan = planStepUpAttempt(stepUpAttemptInput());

    expect(plan).toEqual({
      kind: "step_up_success",
      consume_challenge: true,
      actor_effect: "unchanged",
      session_effect: "unchanged",
      proof: {
        proof_id: ids.proof,
        status: "active",
        challenge_binding: stepUpBinding(),
        issued_at: ACTIVE_NOW,
        expires_at: ACTIVE_NOW + 300,
      },
    });
    expectDeepFrozen(plan);
    if (plan.kind !== "step_up_success") throw new Error("Expected step-up success");
    expect(StepUpProofSchema.parse(plan.proof)).toEqual(plan.proof);
  });

  it("uses the same fifth-failure ceiling for step-up", () => {
    const plan = planStepUpAttempt(
      stepUpAttemptInput({
        challenge: {
          ...createPinChallenge(stepUpChallengeInput()),
          failed_attempts: 4,
        },
        pin_valid: false,
      }),
    );
    expect(plan).toEqual({
      kind: "record_failure",
      challenge_id: ids.challenge,
      next_failed_attempts: 5,
      challenge_exhausted: true,
    });
  });

  it("rejects expired, consumed and exhausted step-up challenges", () => {
    expect(
      planStepUpAttempt(
        stepUpAttemptInput({ now_epoch_seconds: ISSUED_AT + PIN_CHALLENGE_TTL_SECONDS }),
      ),
    ).toEqual({ kind: "reject", reason: "CHALLENGE_EXPIRED" });
    expect(
      planStepUpAttempt(
        stepUpAttemptInput({
          challenge: { ...createPinChallenge(stepUpChallengeInput()), status: "consumed" },
        }),
      ),
    ).toEqual({ kind: "reject", reason: "CHALLENGE_CONSUMED" });
    expect(
      planStepUpAttempt(
        stepUpAttemptInput({
          challenge: {
            ...createPinChallenge(stepUpChallengeInput()),
            failed_attempts: PIN_CHALLENGE_MAX_ATTEMPTS,
          },
        }),
      ),
    ).toEqual({ kind: "reject", reason: "CHALLENGE_EXHAUSTED" });
  });

  it("rejects changed action, args, entity order, idempotency and self approval", () => {
    const changedBindings = [
      stepUpBinding({ pending_action_ref: "command:orders.refund:pending-02" }),
      stepUpBinding({ args_hash: "b".repeat(64) }),
      stepUpBinding({ entity_versions: [...entityVersions].reverse() }),
      stepUpBinding({ idempotency_key: ids.proof }),
    ];
    changedBindings.forEach((currentBinding) =>
      expect(planStepUpAttempt(stepUpAttemptInput({ current_binding: currentBinding }))).toEqual({
        kind: "reject",
        reason: "CHALLENGE_BINDING_MISMATCH",
      }),
    );
    expect(() =>
      planStepUpAttempt(
        stepUpAttemptInput({
          current_binding: stepUpBinding({ approver_staff_id: ids.requester }),
        }),
      ),
    ).toThrow();
  });

  it("rejects quick-switch purpose at the step-up planner", () => {
    expect(
      planStepUpAttempt(
        stepUpAttemptInput({
          challenge: createPinChallenge(quickChallengeInput()),
          current_binding: quickBinding(),
        }),
      ),
    ).toEqual({ kind: "reject", reason: "PURPOSE_MISMATCH" });
  });

  it("consumes an exactly bound active proof while returning actor and session unchanged", () => {
    const issued = planStepUpAttempt(stepUpAttemptInput());
    if (issued.kind !== "step_up_success") throw new Error("Expected step-up success");

    const decision = evaluateStepUpProof({
      proof: issued.proof,
      expected_binding: stepUpBinding(),
      current_actor_staff_id: ids.requester,
      current_session_id: ids.session,
      now_epoch_seconds: ACTIVE_NOW + 60,
    });

    expect(decision).toEqual({
      kind: "consume_step_up_proof",
      proof_id: ids.proof,
      consume_proof: true,
      current_actor_staff_id: ids.requester,
      current_session_id: ids.session,
      actor_effect: "unchanged",
      session_effect: "unchanged",
    });
    expectDeepFrozen(decision);
  });

  it("rejects expired, not-yet-active and consumed proofs", () => {
    const issued = planStepUpAttempt(stepUpAttemptInput());
    if (issued.kind !== "step_up_success") throw new Error("Expected step-up success");
    const base = {
      proof: issued.proof,
      expected_binding: stepUpBinding(),
      current_actor_staff_id: ids.requester,
      current_session_id: ids.session,
    };

    expect(
      evaluateStepUpProof({ ...base, now_epoch_seconds: ACTIVE_NOW + STEP_UP_PROOF_TTL_SECONDS }),
    ).toEqual({ kind: "reject", reason: "PROOF_EXPIRED" });
    expect(evaluateStepUpProof({ ...base, now_epoch_seconds: ACTIVE_NOW - 1 })).toEqual({
      kind: "reject",
      reason: "PROOF_NOT_ACTIVE",
    });
    expect(
      evaluateStepUpProof({
        ...base,
        proof: { ...issued.proof, status: "consumed" },
        now_epoch_seconds: ACTIVE_NOW + 1,
      }),
    ).toEqual({ kind: "reject", reason: "PROOF_CONSUMED" });
  });

  it("rejects every changed proof binding and preserves entity ordering", () => {
    const issued = planStepUpAttempt(stepUpAttemptInput());
    if (issued.kind !== "step_up_success") throw new Error("Expected step-up success");
    const changedBindings = [
      stepUpBinding({ challenge_id: ids.proof }),
      stepUpBinding({ session_id: ids.otherSession }),
      stepUpBinding({ session_version: 5 }),
      stepUpBinding({ org_id: ids.store }),
      stepUpBinding({ store_id: ids.org }),
      stepUpBinding({ device_id: ids.nextSession }),
      stepUpBinding({ nonce: ids.proof }),
      stepUpBinding({ issued_at: ISSUED_AT + 1, expires_at: ISSUED_AT + 121 }),
      stepUpBinding({ pending_action_ref: "command:orders.refund:pending-02" }),
      stepUpBinding({ args_hash: "b".repeat(64) }),
      stepUpBinding({ entity_versions: [...entityVersions].reverse() }),
      stepUpBinding({ idempotency_key: ids.proof }),
      stepUpBinding({ requester_staff_id: ids.target }),
      stepUpBinding({ approver_staff_id: ids.target }),
    ];

    changedBindings.forEach((expectedBinding) =>
      expect(
        evaluateStepUpProof({
          proof: issued.proof,
          expected_binding: expectedBinding,
          current_actor_staff_id: ids.requester,
          current_session_id: ids.session,
          now_epoch_seconds: ACTIVE_NOW + 1,
        }),
      ).toEqual({ kind: "reject", reason: "PROOF_BINDING_MISMATCH" }),
    );
    expect(
      evaluateStepUpProof({
        proof: issued.proof,
        expected_binding: stepUpBinding(),
        current_actor_staff_id: ids.target,
        current_session_id: ids.session,
        now_epoch_seconds: ACTIVE_NOW + 1,
      }),
    ).toEqual({ kind: "reject", reason: "PROOF_BINDING_MISMATCH" });
    expect(
      evaluateStepUpProof({
        proof: issued.proof,
        expected_binding: stepUpBinding(),
        current_actor_staff_id: ids.requester,
        current_session_id: ids.otherSession,
        now_epoch_seconds: ACTIVE_NOW + 1,
      }),
    ).toEqual({ kind: "reject", reason: "PROOF_BINDING_MISMATCH" });
  });

  it("rejects forged self-approval and non-exact proof TTL records", () => {
    const issued = planStepUpAttempt(stepUpAttemptInput());
    if (issued.kind !== "step_up_success") throw new Error("Expected step-up success");
    expect(() =>
      StepUpProofSchema.parse({
        ...issued.proof,
        challenge_binding: {
          ...issued.proof.challenge_binding,
          approver_staff_id: ids.requester,
        },
      }),
    ).toThrow();
    expect(() =>
      StepUpProofSchema.parse({ ...issued.proof, expires_at: ACTIVE_NOW + 301 }),
    ).toThrow();
  });
});

describe("A5 PIN plain-data and secret boundary", () => {
  it("rejects accessors without executing them", () => {
    let getterCalls = 0;
    const input = quickChallengeInput();
    Object.defineProperty(input, "purpose", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "quick_switch";
      },
    });
    expect(() => createPinChallenge(input)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("rejects class, boxed, extra, missing and unstable factory inputs", () => {
    class ChallengeInput {
      purpose = "quick_switch";
    }
    const valid = quickChallengeInput();
    [
      new ChallengeInput(),
      new String("1234"),
      { ...valid, extra: true },
      { ...valid, nonce: undefined },
      unstableProxy(valid, "purpose"),
    ].forEach((input) => expect(() => createPinChallenge(input)).toThrow());
  });

  it("enforces exact planner and proof-evaluator inputs", () => {
    expect(() => planQuickSwitchAttempt({ ...quickAttemptInput(), extra: true })).toThrow();
    expect(() => planStepUpAttempt({ ...stepUpAttemptInput(), extra: true })).toThrow();
    let getterCalls = 0;
    const accessorInput = quickAttemptInput();
    Object.defineProperty(accessorInput, "pin_valid", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    expect(() => planQuickSwitchAttempt(accessorInput)).toThrow();
    expect(getterCalls).toBe(0);
    const issued = planStepUpAttempt(stepUpAttemptInput());
    if (issued.kind !== "step_up_success") throw new Error("Expected step-up success");
    expect(() =>
      evaluateStepUpProof({
        proof: issued.proof,
        expected_binding: stepUpBinding(),
        current_actor_staff_id: ids.requester,
        current_session_id: ids.session,
        now_epoch_seconds: ACTIVE_NOW + 1,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      evaluateStepUpProof(
        unstableProxy(
          {
            proof: issued.proof,
            expected_binding: stepUpBinding(),
            current_actor_staff_id: ids.requester,
            current_session_id: ids.session,
            now_epoch_seconds: ACTIVE_NOW + 1,
          },
          "now_epoch_seconds",
        ),
      ),
    ).toThrow();
  });

  it("never returns a submitted PIN value or PIN field", () => {
    const rawPin = "93847561";
    const outputs = [
      createPinChallenge(quickChallengeInput()),
      planQuickSwitchAttempt(quickAttemptInput({ pin_valid: false })),
      planQuickSwitchAttempt(quickAttemptInput()),
      planStepUpAttempt(stepUpAttemptInput()),
    ];
    outputs.forEach((output) => {
      const serialized = JSON.stringify(output);
      expect(serialized).not.toContain(rawPin);
      expect(serialized).not.toMatch(/"pin"\s*:/iu);
      expectDeepFrozen(output);
    });
  });
});
