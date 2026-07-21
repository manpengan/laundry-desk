import { z } from "zod";

import { EmptyBodySchema, LoginRequestSchema, PinVerifyRequestSchema } from "../auth/operations.js";
import { defineCommand, type CommandDefinition } from "../registry/definitions.js";

/**
 * A6 identity command catalog (contract-only).
 * Lifecycle HTTP matrix remains in auth/operations.ts; these are A1 registry entries for C1.
 */

const OpaqueReferenceSchema = z
  .string()
  .regex(/^[\x21-\x7E]{1,256}$/u, "Expected a non-empty visible ASCII reference");

/** ZodObject form of pin challenge (discriminated union is not a ZodObject for defineCommand). */
export const IdentityPinChallengeInputSchema = z
  .strictObject({
    purpose: z.enum(["quick_switch", "step_up"]),
    target_staff_id: z.uuid().optional(),
    pending_action_ref: OpaqueReferenceSchema.optional(),
    approver_staff_id: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.purpose === "quick_switch" && value.target_staff_id === undefined) {
      context.addIssue({
        code: "custom",
        message: "quick_switch requires target_staff_id",
        path: ["target_staff_id"],
      });
    }
    if (value.purpose === "step_up") {
      if (value.pending_action_ref === undefined) {
        context.addIssue({
          code: "custom",
          message: "step_up requires pending_action_ref",
          path: ["pending_action_ref"],
        });
      }
      if (value.approver_staff_id === undefined) {
        context.addIssue({
          code: "custom",
          message: "step_up requires approver_staff_id",
          path: ["approver_staff_id"],
        });
      }
    }
  });

type LoginInput = typeof LoginRequestSchema;
type EmptyInput = typeof EmptyBodySchema;
type PinChallengeInput = typeof IdentityPinChallengeInputSchema;
type PinVerifyInput = typeof PinVerifyRequestSchema;

export const identityLoginCommand: CommandDefinition<LoginInput> = defineCommand({
  name: "identity.login",
  version: "1.0.0",
  description: "Authenticate staff with password and establish browser session cookies.",
  description_llm:
    "Verify org/store/username/password for a device and open a session. Never log or project the password.",
  input: LoginRequestSchema,
  risk: "R1",
  invariants: ["identity.credentials_valid", "identity.device_bound"],
  idempotent: false,
  sideEffects: ["identity.session_opened", "audit.auth_event"],
  offline_mode: "denied",
  data_classification: "secret",
  input_redaction: [{ path: "/password", strategy: "remove" }],
  result_redaction: [{ path: "/access_token", strategy: "remove" }],
});

export const identityRefreshCommand: CommandDefinition<EmptyInput> = defineCommand({
  name: "identity.refresh",
  version: "1.0.0",
  description: "Rotate refresh session and issue a new memory-only access token.",
  description_llm:
    "Consume the httpOnly refresh cookie under CSRF proof and return a new access token. No password body.",
  input: EmptyBodySchema,
  risk: "R1",
  invariants: ["identity.refresh_valid", "identity.csrf_valid"],
  idempotent: false,
  sideEffects: ["identity.session_rotated", "audit.auth_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [{ path: "/access_token", strategy: "remove" }],
});

export const identityLogoutCommand: CommandDefinition<EmptyInput> = defineCommand({
  name: "identity.logout",
  version: "1.0.0",
  description: "Revoke the current refresh family and clear auth cookies.",
  description_llm: "End the browser session and clear refresh/CSRF cookies under CSRF proof.",
  input: EmptyBodySchema,
  risk: "R0",
  invariants: ["identity.session_revocable"],
  idempotent: true,
  sideEffects: ["identity.session_revoked", "audit.auth_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const identityPinChallengeCommand: CommandDefinition<PinChallengeInput> = defineCommand({
  name: "identity.pin_challenge",
  version: "1.0.0",
  description: "Create a single-use PIN challenge for quick switch or step-up.",
  description_llm:
    "Issue a short-lived PIN challenge bound to quick_switch or step_up purpose. Does not accept the PIN itself.",
  input: IdentityPinChallengeInputSchema,
  risk: "R2",
  invariants: ["identity.actor_active", "identity.pin_challenge_policy"],
  idempotent: false,
  sideEffects: ["identity.pin_challenge_issued", "audit.auth_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const identityPinVerifyCommand: CommandDefinition<PinVerifyInput> = defineCommand({
  name: "identity.pin_verify",
  version: "1.0.0",
  description: "Verify PIN against an open challenge for quick switch or step-up proof.",
  description_llm:
    "Submit PIN for a challenge_id. On success returns session switch or step-up proof. Never project the PIN.",
  input: PinVerifyRequestSchema,
  risk: "R2",
  invariants: ["identity.pin_challenge_open", "identity.pin_not_locked"],
  idempotent: false,
  sideEffects: ["identity.pin_verified", "audit.auth_event"],
  offline_mode: "denied",
  data_classification: "secret",
  input_redaction: [{ path: "/pin", strategy: "remove" }],
  result_redaction: [{ path: "/access_token", strategy: "remove" }],
});

export const IDENTITY_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  identityLoginCommand,
  identityRefreshCommand,
  identityLogoutCommand,
  identityPinChallengeCommand,
  identityPinVerifyCommand,
]);

export const IDENTITY_COMMAND_NAMES = Object.freeze(
  IDENTITY_COMMANDS.map((command) => command.name),
);
