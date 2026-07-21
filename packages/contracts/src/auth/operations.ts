import { z } from "zod";

import {
  AUTH_PUBLIC_ERROR_DESCRIPTORS,
  type AuthPublicErrorDescriptor,
  type CommandErrorCode,
} from "../envelope/responses.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "./session.js";
import { PIN_CHALLENGE_MAX_ATTEMPTS, PinSchema } from "./pin.js";
import { snapshotPlainData } from "./plain-data.js";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const EpochSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const VisibleCodeSchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,128}$/u, "Expected 1-128 visible ASCII characters");
const OpaqueReferenceSchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,256}$/u, "Expected a non-empty visible ASCII reference");
const PasswordSchema = z.string().min(1, "Password is required").max(1_024, "Password is too long");
const CompactAccessTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/u, "Expected a compact access token");

export const LoginRequestSchema = z.strictObject({
  org_code: VisibleCodeSchema,
  store_code: VisibleCodeSchema,
  username: VisibleCodeSchema,
  password: PasswordSchema,
  device_id: z.uuid(),
});

export const EmptyBodySchema = z.strictObject({});

export const PinChallengeRequestSchema = z.discriminatedUnion("purpose", [
  z.strictObject({ purpose: z.literal("quick_switch"), target_staff_id: z.uuid() }),
  z.strictObject({
    purpose: z.literal("step_up"),
    pending_action_ref: OpaqueReferenceSchema,
    approver_staff_id: z.uuid(),
  }),
]);

export const PinVerifyRequestSchema = z.strictObject({
  challenge_id: z.uuid(),
  pin: PinSchema,
});

const BrowserSessionViewSchema = z.strictObject({
  session_id: z.uuid(),
  session_version: PositiveSafeIntegerSchema,
  org_id: z.uuid(),
  store_id: z.uuid(),
  staff_id: z.uuid(),
  device_id: z.uuid(),
  permission_version: PositiveSafeIntegerSchema,
});

export const AccessSessionResponseSchema = z.strictObject({
  access_token: CompactAccessTokenSchema,
  token_type: z.literal("Bearer"),
  expires_in: z.literal(ACCESS_TOKEN_TTL_SECONDS),
  storage: z.literal("memory_only"),
  session: BrowserSessionViewSchema,
});

export const LogoutResponseSchema = z.strictObject({ logged_out: z.literal(true) });

export const PinChallengeResponseSchema = z.strictObject({
  challenge_id: z.uuid(),
  purpose: z.enum(["quick_switch", "step_up"]),
  expires_at: EpochSecondsSchema,
  max_attempts: z.literal(PIN_CHALLENGE_MAX_ATTEMPTS),
});

const StepUpProofResponseSchema = z.strictObject({
  step_up_proof_id: z.uuid(),
  expires_at: EpochSecondsSchema,
});

export const PinVerifyResponseSchema = z.union([
  AccessSessionResponseSchema,
  StepUpProofResponseSchema,
]);

export type LoginRequest = Readonly<z.output<typeof LoginRequestSchema>>;
export type EmptyBody = Readonly<z.output<typeof EmptyBodySchema>>;
export type PinChallengeRequest = Readonly<z.output<typeof PinChallengeRequestSchema>>;
export type PinVerifyRequest = Readonly<z.output<typeof PinVerifyRequestSchema>>;
export type AccessSessionResponse = DeepReadonly<z.output<typeof AccessSessionResponseSchema>>;

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
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)])),
    ) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
};

type AuthOperationRequirements = Readonly<{
  origin: "required";
  fetch_metadata: "required";
  access: "forbidden" | "not_required" | "active_required";
  refresh_cookie: "forbidden" | "required" | "not_required";
  csrf: "not_required" | "required";
  allowed_surfaces: readonly ("browser_http" | "ui")[];
  offline: false;
}>;

type AuthCookieEffects =
  | Readonly<{
      refresh: "set" | "rotate" | "clear" | "replace" | "none";
      csrf: "set" | "rotate" | "clear" | "replace" | "none";
    }>
  | Readonly<{
      quick_switch: Readonly<{ refresh: "replace"; csrf: "replace" }>;
      step_up: Readonly<{ refresh: "none"; csrf: "none" }>;
    }>;

type AuthOperationRow = Readonly<{
  operation: "login" | "refresh" | "logout" | "pin_challenge" | "pin_verify";
  command?: "identity.login" | "identity.refresh" | "identity.logout";
  method: "POST";
  path: string;
  ingress: "lifecycle_http" | "browser_session";
  requirements: AuthOperationRequirements;
  cookie_effects: AuthCookieEffects;
  request_schema_id: string;
  response_schema_id: string;
  allowed_public_errors: readonly CommandErrorCode[];
  auth_error_descriptors: readonly AuthPublicErrorDescriptor[];
  request_schema: z.ZodType;
  response_schema: z.ZodType;
}>;

const AUTH_ERROR_DESCRIPTORS = Object.freeze([
  AUTH_PUBLIC_ERROR_DESCRIPTORS.AUTHENTICATION_FAILED,
  AUTH_PUBLIC_ERROR_DESCRIPTORS.CSRF_REJECTED,
  AUTH_PUBLIC_ERROR_DESCRIPTORS.RATE_LIMITED,
] as const satisfies readonly AuthPublicErrorDescriptor[]);

const LIFECYCLE_PUBLIC_ERRORS = Object.freeze([
  "VALIDATION_FAILED",
  "AUTHENTICATION_FAILED",
  "CSRF_REJECTED",
  "RATE_LIMITED",
  "TRANSACTION_FAILED",
  "EVENT_DISPATCH_FAILED",
] as const satisfies readonly CommandErrorCode[]);

const PIN_PUBLIC_ERRORS = Object.freeze([
  "VALIDATION_FAILED",
  "AUTHENTICATION_FAILED",
  "PERMISSION_DENIED",
  "RESOURCE_UNAVAILABLE",
  "CSRF_REJECTED",
  "RATE_LIMITED",
  "INVARIANT_FAILED",
  "TRANSACTION_FAILED",
  "EVENT_DISPATCH_FAILED",
] as const satisfies readonly CommandErrorCode[]);

const BROWSER_HTTP_REQUIREMENTS = Object.freeze({
  origin: "required" as const,
  fetch_metadata: "required" as const,
  access: "forbidden" as const,
  refresh_cookie: "forbidden" as const,
  csrf: "not_required" as const,
  allowed_surfaces: Object.freeze(["browser_http"] as const),
  offline: false as const,
});

const REFRESH_LIFECYCLE_REQUIREMENTS = Object.freeze({
  origin: "required" as const,
  fetch_metadata: "required" as const,
  access: "not_required" as const,
  refresh_cookie: "required" as const,
  csrf: "required" as const,
  allowed_surfaces: Object.freeze(["browser_http"] as const),
  offline: false as const,
});

const PIN_REQUIREMENTS = Object.freeze({
  origin: "required" as const,
  fetch_metadata: "required" as const,
  access: "active_required" as const,
  refresh_cookie: "not_required" as const,
  csrf: "required" as const,
  allowed_surfaces: Object.freeze(["ui"] as const),
  offline: false as const,
});

const schemaPair = <TRequest extends z.ZodType, TResponse extends z.ZodType>(
  request_schema: TRequest,
  response_schema: TResponse,
) => ({ request_schema, response_schema });

/** ADR-11/design §3.5: the sole A7 source for browser auth operation projection. */
export const AUTH_OPERATION_MATRIX = Object.freeze([
  Object.freeze({
    operation: "login" as const,
    command: "identity.login" as const,
    method: "POST" as const,
    path: "/api/v2/auth/login" as const,
    ingress: "lifecycle_http" as const,
    requirements: BROWSER_HTTP_REQUIREMENTS,
    cookie_effects: Object.freeze({ refresh: "set" as const, csrf: "set" as const }),
    request_schema_id: "auth.login.request" as const,
    response_schema_id: "auth.access_session.response" as const,
    allowed_public_errors: LIFECYCLE_PUBLIC_ERRORS,
    auth_error_descriptors: AUTH_ERROR_DESCRIPTORS,
    ...schemaPair(LoginRequestSchema, AccessSessionResponseSchema),
  }),
  Object.freeze({
    operation: "refresh" as const,
    command: "identity.refresh" as const,
    method: "POST" as const,
    path: "/api/v2/auth/refresh" as const,
    ingress: "lifecycle_http" as const,
    requirements: REFRESH_LIFECYCLE_REQUIREMENTS,
    cookie_effects: Object.freeze({ refresh: "rotate" as const, csrf: "rotate" as const }),
    request_schema_id: "auth.empty.request" as const,
    response_schema_id: "auth.access_session.response" as const,
    allowed_public_errors: LIFECYCLE_PUBLIC_ERRORS,
    auth_error_descriptors: AUTH_ERROR_DESCRIPTORS,
    ...schemaPair(EmptyBodySchema, AccessSessionResponseSchema),
  }),
  Object.freeze({
    operation: "logout" as const,
    command: "identity.logout" as const,
    method: "POST" as const,
    path: "/api/v2/auth/logout" as const,
    ingress: "lifecycle_http" as const,
    requirements: REFRESH_LIFECYCLE_REQUIREMENTS,
    cookie_effects: Object.freeze({ refresh: "clear" as const, csrf: "clear" as const }),
    request_schema_id: "auth.empty.request" as const,
    response_schema_id: "auth.logout.response" as const,
    allowed_public_errors: LIFECYCLE_PUBLIC_ERRORS,
    auth_error_descriptors: AUTH_ERROR_DESCRIPTORS,
    ...schemaPair(EmptyBodySchema, LogoutResponseSchema),
  }),
  Object.freeze({
    operation: "pin_challenge" as const,
    method: "POST" as const,
    path: "/api/v2/auth/pin/challenges" as const,
    ingress: "browser_session" as const,
    requirements: PIN_REQUIREMENTS,
    cookie_effects: Object.freeze({ refresh: "none" as const, csrf: "none" as const }),
    request_schema_id: "auth.pin_challenge.request" as const,
    response_schema_id: "auth.pin_challenge.response" as const,
    allowed_public_errors: PIN_PUBLIC_ERRORS,
    auth_error_descriptors: AUTH_ERROR_DESCRIPTORS,
    ...schemaPair(PinChallengeRequestSchema, PinChallengeResponseSchema),
  }),
  Object.freeze({
    operation: "pin_verify" as const,
    method: "POST" as const,
    path: "/api/v2/auth/pin/challenges/{challenge_id}/verify" as const,
    ingress: "browser_session" as const,
    requirements: PIN_REQUIREMENTS,
    cookie_effects: Object.freeze({
      quick_switch: Object.freeze({ refresh: "replace" as const, csrf: "replace" as const }),
      step_up: Object.freeze({ refresh: "none" as const, csrf: "none" as const }),
    }),
    request_schema_id: "auth.pin_verify.request" as const,
    response_schema_id: "auth.pin_verify.response" as const,
    allowed_public_errors: PIN_PUBLIC_ERRORS,
    auth_error_descriptors: AUTH_ERROR_DESCRIPTORS,
    ...schemaPair(PinVerifyRequestSchema, PinVerifyResponseSchema),
  }),
] as const satisfies readonly AuthOperationRow[]);

export type AuthOperationDescriptor = (typeof AUTH_OPERATION_MATRIX)[number];

export const IdentityLifecycleOperationSchema = z.enum([
  "identity.login",
  "identity.refresh",
  "identity.logout",
]);

const LifecycleHttpIngressFields = {
  kind: z.literal("lifecycle_http"),
  origin_verified: z.literal(true),
  fetch_metadata_verified: z.literal(true),
};

const LoginIngressSchema = z.strictObject({
  ...LifecycleHttpIngressFields,
  refresh_session_verified: z.literal(false),
  csrf_verified: z.literal(false),
});

const RefreshIngressSchema = z.strictObject({
  ...LifecycleHttpIngressFields,
  refresh_session_verified: z.literal(true),
  csrf_verified: z.literal(true),
});

const IdentityLifecycleEnvelopeFields = { request_id: z.uuid() };
const IdentityLifecycleEnvelopeSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...IdentityLifecycleEnvelopeFields,
    operation: z.literal("identity.login"),
    body: LoginRequestSchema,
    ingress: LoginIngressSchema,
  }),
  z.strictObject({
    ...IdentityLifecycleEnvelopeFields,
    operation: z.literal("identity.refresh"),
    body: EmptyBodySchema,
    ingress: RefreshIngressSchema,
  }),
  z.strictObject({
    ...IdentityLifecycleEnvelopeFields,
    operation: z.literal("identity.logout"),
    body: EmptyBodySchema,
    ingress: RefreshIngressSchema,
  }),
]);

declare const IDENTITY_LIFECYCLE_ENVELOPE_BRAND: unique symbol;
type IdentityLifecycleEnvelopeBrand = Readonly<{
  [IDENTITY_LIFECYCLE_ENVELOPE_BRAND]: true;
}>;

export type IdentityLifecycleEnvelope = DeepReadonly<
  z.output<typeof IdentityLifecycleEnvelopeSchema>
> &
  IdentityLifecycleEnvelopeBrand;

const registeredLifecycleEnvelopes = new WeakSet<object>();

/** @internal Restricted browser ingress calls this after verifying the HTTP security gates. */
export const registerIdentityLifecycleEnvelope = (input: unknown): IdentityLifecycleEnvelope => {
  const parsed = IdentityLifecycleEnvelopeSchema.parse(
    snapshotPlainData(input, "identity lifecycle ingress"),
  );
  const envelope = deepFreeze(parsed) as IdentityLifecycleEnvelope;
  registeredLifecycleEnvelopes.add(envelope);
  return envelope;
};

/** Returns true only for an envelope issued by the restricted lifecycle HTTP authority. */
export const isIdentityLifecycleEnvelope = (value: unknown): value is IdentityLifecycleEnvelope =>
  typeof value === "object" && value !== null && registeredLifecycleEnvelopes.has(value);
