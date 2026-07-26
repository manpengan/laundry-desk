import { z } from "zod";

import { PIN_CHALLENGE_MAX_ATTEMPTS, PinSchema } from "./pin.js";
import { ACCESS_TOKEN_TTL_SECONDS } from "./session.js";

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

const BrowserSessionRoleSchema = z.enum(["admin", "staff"]);
const BrowserSessionFeaturesSchema = z.record(z.string(), z.boolean());
const BrowserSessionDisplaySchema = z.strictObject({
  store_name: z.string(),
  staff_name: z.string(),
  org_code: z.string(),
  store_code: z.string(),
});

export const AccessSessionResponseSchema = z.strictObject({
  access_token: CompactAccessTokenSchema,
  token_type: z.literal("Bearer"),
  expires_in: z.literal(ACCESS_TOKEN_TTL_SECONDS),
  storage: z.literal("memory_only"),
  session: BrowserSessionViewSchema,
  role: BrowserSessionRoleSchema,
  features: BrowserSessionFeaturesSchema,
  display: BrowserSessionDisplaySchema,
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

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type LoginRequest = Readonly<z.output<typeof LoginRequestSchema>>;
export type EmptyBody = Readonly<z.output<typeof EmptyBodySchema>>;
export type PinChallengeRequest = Readonly<z.output<typeof PinChallengeRequestSchema>>;
export type PinVerifyRequest = Readonly<z.output<typeof PinVerifyRequestSchema>>;
export type AccessSessionResponse = DeepReadonly<z.output<typeof AccessSessionResponseSchema>>;
