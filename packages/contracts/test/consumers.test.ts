import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as PublicContracts from "../src/index.js";
import {
  AUTH_OPERATION_MATRIX,
  AUTH_PUBLIC_ERROR_DESCRIPTORS,
  AccessSessionResponseSchema,
  CsrfProofSchema,
  EmptyBodySchema,
  LoginRequestSchema,
  LogoutResponseSchema,
  PinSchema,
  PinChallengeRequestSchema,
  PinChallengeResponseSchema,
  PinVerifyRequestSchema,
  PinVerifyResponseSchema,
  classifyRefreshCasCommit,
  defineCommand,
  defineQuery,
  evaluateCsrfRequest,
  evaluateLoginPreAuthOrigin,
  isAiProjectableDefinition,
  parseContractInput,
  validateStricterLimitOverride,
  type CommandDefinition,
  type ContractDefinition,
} from "../src/index.js";

const input = z.strictObject({ order_ids: z.array(z.string().uuid()), amount_cents: z.number() });

const command = defineCommand({
  name: "orders.cancel_many",
  version: "1.0.0",
  description: "Cancel several orders",
  description_llm: "Cancel validated orders within declared limits.",
  input,
  risk: "R3",
  invariants: ["orders.cancelable"],
  idempotent: true,
  sideEffects: ["orders.status_changed"],
  offline_mode: "grant",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: {
    batch: { kind: "array_length", path: "/order_ids" },
    amount: { kind: "field", path: "/amount_cents" },
  },
  hard_limits: { max_batch: 20, max_amount_cents: 100_000 },
  risk_escalation: { max_batch: 10, max_amount_cents: 50_000 },
});

const query = defineQuery({
  name: "orders.list",
  version: "1.0.0",
  description: "List orders",
  description_llm: "List a bounded set of orders.",
  input: z.strictObject({ limit: z.number().int().positive() }),
  risk: "R1",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 100,
});

describe("C1 command-bus consumer", () => {
  const execute = <TInput extends z.ZodObject>(
    definition: CommandDefinition<TInput>,
    rawInput: unknown,
  ): Promise<z.output<TInput>> => parseContractInput(definition, rawInput);

  it("validates through the preserved input schema and reads executable bindings", async () => {
    const parsed = await execute(command, {
      order_ids: [crypto.randomUUID()],
      amount_cents: 1_000,
    });

    expect(parsed.amount_cents).toBe(1_000);
    expect(command.invariants).toEqual(["orders.cancelable"]);
    expect(command.sideEffects).toEqual(["orders.status_changed"]);
  });
});

describe("C4 tool-registry consumer", () => {
  const project = (
    definition: ContractDefinition<"command" | "query", z.ZodObject>,
  ): Readonly<{ name: string; description: string }> | undefined =>
    isAiProjectableDefinition(definition)
      ? Object.freeze({ name: definition.name, description: definition.description_llm })
      : undefined;

  it("projects supported definitions through the R5 guard", () => {
    expect(project(command)).toEqual({
      name: "orders.cancel_many",
      description: "Cancel validated orders within declared limits.",
    });
    expect(project(query)).toEqual({
      name: "orders.list",
      description: "List a bounded set of orders.",
    });
  });
});

describe("C5 policy consumer", () => {
  it("uses typed factory limits and accepts only a stricter organization override", () => {
    const merged = validateStricterLimitOverride(
      {
        hard_limits: command.hard_limits,
        risk_escalation: command.risk_escalation,
      },
      {
        hard_limits: { max_batch: 15 },
        risk_escalation: { max_batch: 8, max_amount_cents: 40_000 },
      },
    );

    expect(merged).toEqual({
      hard_limits: { max_batch: 15, max_amount_cents: 100_000 },
      risk_escalation: { max_batch: 8, max_amount_cents: 40_000 },
    });
  });
});

describe("C6/C8 auth contract consumer", () => {
  it("consumes public browser schemas and pure runtime decisions from the root entry point", () => {
    expect(
      LoginRequestSchema.parse({
        org_code: "org-001",
        store_code: "store-001",
        username: "cashier-001",
        password: "request-only-secret",
        device_id: "10000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ username: "cashier-001" });
    expect(EmptyBodySchema.parse({})).toEqual({});
    expect(
      PinChallengeRequestSchema.parse({
        purpose: "quick_switch",
        target_staff_id: "10000000-0000-4000-8000-000000000002",
      }),
    ).toMatchObject({ purpose: "quick_switch" });
    expect(
      PinVerifyRequestSchema.parse({
        challenge_id: "10000000-0000-4000-8000-000000000003",
        pin: "1234",
      }),
    ).toMatchObject({ pin: "1234" });
    expect(
      evaluateLoginPreAuthOrigin({
        method: "POST",
        origin_allowed: true,
        fetch_site: "same-origin",
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateCsrfRequest({
        method: "POST",
        origin_allowed: false,
        fetch_site: "cross-site",
        cookie_present: false,
        header_present: false,
        tokens_match: false,
        proof_valid: false,
      }),
    ).toEqual({ allowed: false, reason: "ORIGIN_NOT_ALLOWED" });
    expect(classifyRefreshCasCommit({ matched_rows: 0 })).toEqual({
      kind: "stale",
      action: "reload_and_reject",
      public_code: "AUTHENTICATION_FAILED",
    });
  });

  it("keeps authority and server-only schemas off the root entry point", () => {
    [
      "issueBrowserSessionSource",
      "issueEdgeReplaySource",
      "issueIdentityLifecycleEnvelope",
      "registerIdentityLifecycleEnvelope",
      "RefreshTokenRecordSchema",
      "RefreshFamilyRecordSchema",
      "ServerSessionRecordSchema",
      "PinChallengeSchema",
      "PinVerificationSchema",
      "StepUpProofSchema",
    ].forEach((name) => expect(name in PublicContracts).toBe(false));
  });
});

describe("A7 auth projection consumer", () => {
  const accessResponse = {
    access_token: "header.payload.signature",
    token_type: "Bearer",
    expires_in: 900,
    storage: "memory_only",
    session: {
      session_id: "10000000-0000-4000-8000-000000000011",
      session_version: 1,
      org_id: "10000000-0000-4000-8000-000000000012",
      store_id: "10000000-0000-4000-8000-000000000013",
      staff_id: "10000000-0000-4000-8000-000000000014",
      device_id: "10000000-0000-4000-8000-000000000015",
      permission_version: 1,
    },
  } as const;

  it("projects exactly the five matrix-owned browser request/response pairs", () => {
    expect(AUTH_OPERATION_MATRIX.map((row) => row.operation)).toEqual([
      "login",
      "refresh",
      "logout",
      "pin_challenge",
      "pin_verify",
    ]);
    expect(AUTH_OPERATION_MATRIX.map((row) => row.request_schema)).toEqual([
      LoginRequestSchema,
      EmptyBodySchema,
      EmptyBodySchema,
      PinChallengeRequestSchema,
      PinVerifyRequestSchema,
    ]);
    expect(AUTH_OPERATION_MATRIX.map((row) => row.response_schema)).toEqual([
      AccessSessionResponseSchema,
      AccessSessionResponseSchema,
      LogoutResponseSchema,
      PinChallengeResponseSchema,
      PinVerifyResponseSchema,
    ]);
    expect(AUTH_OPERATION_MATRIX.map((row) => row.request_schema_id)).toEqual([
      "auth.login.request",
      "auth.empty.request",
      "auth.empty.request",
      "auth.pin_challenge.request",
      "auth.pin_verify.request",
    ]);
    expect(AUTH_PUBLIC_ERROR_DESCRIPTORS).toEqual({
      AUTHENTICATION_FAILED: {
        code: "AUTHENTICATION_FAILED",
        message: "Authentication failed",
        http_status: 401,
      },
      CSRF_REJECTED: {
        code: "CSRF_REJECTED",
        message: "Request origin verification failed",
        http_status: 403,
      },
      RATE_LIMITED: {
        code: "RATE_LIMITED",
        message: "Too many requests",
        http_status: 429,
      },
    });
  });

  it("has no secret examples and rejects request secrets or server bindings in results", () => {
    expect(LoginRequestSchema.meta()?.examples).toBeUndefined();
    expect(PinVerifyRequestSchema.meta()?.examples).toBeUndefined();
    expect(PinSchema.meta()?.examples).toBeUndefined();
    expect(CsrfProofSchema.meta()?.examples).toBeUndefined();

    const forbiddenResultFields = [
      ["password", "password-secret"],
      ["pin", "1234"],
      ["refresh_token", "refresh-secret"],
      ["csrf_token", "csrf-secret"],
      ["token_hash", "hash-secret"],
      ["challenge_binding", { session_id: accessResponse.session.session_id }],
    ] as const;
    const resultCandidates = [
      [AccessSessionResponseSchema, accessResponse],
      [LogoutResponseSchema, { logged_out: true }],
      [
        PinChallengeResponseSchema,
        {
          challenge_id: "10000000-0000-4000-8000-000000000016",
          purpose: "quick_switch",
          expires_at: 2_000,
          max_attempts: 5,
        },
      ],
      [PinVerifyResponseSchema, accessResponse],
      [
        PinVerifyResponseSchema,
        {
          step_up_proof_id: "10000000-0000-4000-8000-000000000017",
          expires_at: 2_000,
        },
      ],
    ] as const;

    resultCandidates.forEach(([schema, candidate]) => {
      forbiddenResultFields.forEach(([field, value]) => {
        expect(schema.safeParse({ ...candidate, [field]: value }).success).toBe(false);
      });
    });
    expect(JSON.stringify(AUTH_OPERATION_MATRIX)).not.toMatch(
      /password-secret|1234|refresh-secret|csrf-secret|hash-secret/u,
    );
  });
});
