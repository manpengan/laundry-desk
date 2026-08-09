import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

export const StaffAccessListInputSchema = z.strictObject({});

const StaffUsernameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/u, "username must contain visible ASCII only");

const StaffDisplayNameSchema = z.string().trim().min(1).max(128);
const StaffReasonSchema = z.string().trim().min(1).max(256);
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const StaffCreateInputSchema = z
  .strictObject({
    username: StaffUsernameSchema,
    display_name: StaffDisplayNameSchema,
    role: z.enum(["admin", "staff"]),
    privacy_admin: z.boolean(),
    reason: StaffReasonSchema,
  })
  .superRefine((input, context) => {
    if (input.privacy_admin && input.role !== "admin") {
      context.addIssue({
        code: "custom",
        message: "privacy_admin requires an admin role",
        path: ["privacy_admin"],
      });
    }
  });

export const StaffCredentialsResetInputSchema = z.strictObject({
  target_staff_id: z.uuid(),
  expected_permission_version: PositiveSafeIntegerSchema,
  reason: StaffReasonSchema,
});

export const StaffCredentialSetupResultSchema = z.strictObject({
  credential_setup_ref: z.uuid(),
  target_staff_id: z.uuid(),
  expires_at: PositiveSafeIntegerSchema,
  status: z.literal("pending"),
});

export const StaffCredentialsCompleteRequestSchema = z.strictObject({
  credential_setup_ref: z.uuid(),
  password: z.string().min(12).max(256),
  pin: z.string().regex(/^\d{6,8}$/u, "pin must contain 6 to 8 digits"),
});

export const StaffCredentialsCompleteResponseSchema = z.strictObject({
  target_staff_id: z.uuid(),
  permission_version: PositiveSafeIntegerSchema,
  status: z.literal("active"),
});

export const StaffAccessSetInputSchema = z
  .strictObject({
    target_staff_id: z.uuid(),
    expected_permission_version: PositiveSafeIntegerSchema,
    role: z.enum(["admin", "staff"]),
    privacy_admin: z.boolean(),
    is_active: z.boolean(),
    reason: StaffReasonSchema,
  })
  .superRefine((input, context) => {
    if (input.privacy_admin && (input.role !== "admin" || !input.is_active)) {
      context.addIssue({
        code: "custom",
        message: "privacy_admin requires an active admin role",
        path: ["privacy_admin"],
      });
    }
  });

export const staffAccessListQuery: QueryDefinition<typeof StaffAccessListInputSchema> = defineQuery(
  {
    name: "staff.access.list",
    version: "1.0.0",
    description: "List staff access assignments for the authenticated store.",
    description_llm: "Return bounded staff role and privacy authority assignments for this store.",
    input: StaffAccessListInputSchema,
    risk: "R2",
    invariants: [],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: [
      { path: "/staff/*/username", strategy: "mask" },
      { path: "/staff/*/display_name", strategy: "mask" },
    ],
    max_result_rows: 200,
  },
);

export const staffAccessSetCommand: CommandDefinition<typeof StaffAccessSetInputSchema> =
  defineCommand({
    name: "staff.access.set",
    version: "1.0.0",
    description: "Change one staff member's role, privacy authority, or active status.",
    description_llm:
      "R5 access change. Requires step-up, optimistic permission version, session revocation, and audit.",
    input: StaffAccessSetInputSchema,
    risk: "R5",
    invariants: ["rbac.staff_write", "staff.access_safe"],
    idempotent: true,
    sideEffects: ["staff.access_changed", "identity.sessions_revoked", "audit.staff_access_event"],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [{ path: "/reason", strategy: "mask" }],
    result_redaction: [],
  });

export const staffCreateCommand: CommandDefinition<typeof StaffCreateInputSchema> = defineCommand({
  name: "staff.create",
  version: "1.0.0",
  description: "Create an inactive staff identity and one bounded credential setup reference.",
  description_llm:
    "R5 staff creation. The command never accepts or persists plaintext password or PIN values.",
  input: StaffCreateInputSchema,
  risk: "R5",
  invariants: ["rbac.staff_write", "staff.access_safe"],
  idempotent: true,
  sideEffects: ["staff.created_inactive", "staff.credential_setup_issued", "audit.staff_created"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/reason", strategy: "mask" }],
  result_redaction: [],
});

export const staffCredentialsResetCommand: CommandDefinition<
  typeof StaffCredentialsResetInputSchema
> = defineCommand({
  name: "staff.credentials.reset",
  version: "1.0.0",
  description:
    "Invalidate one staff credential set and issue a bounded replacement setup reference.",
  description_llm:
    "R5 credential reset. Revokes target sessions, deactivates the target, and never accepts new secrets.",
  input: StaffCredentialsResetInputSchema,
  risk: "R5",
  invariants: ["rbac.staff_write", "staff.access_safe"],
  idempotent: true,
  sideEffects: [
    "staff.credentials_invalidated",
    "staff.credential_setup_issued",
    "identity.sessions_revoked",
    "audit.staff_credentials_reset",
  ],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/reason", strategy: "mask" }],
  result_redaction: [],
});

export const STAFF_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  staffAccessSetCommand,
  staffCreateCommand,
  staffCredentialsResetCommand,
]);

export const STAFF_QUERIES: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  staffAccessListQuery,
]);

export const STAFF_DEFINITIONS = Object.freeze([...STAFF_COMMANDS, ...STAFF_QUERIES]);
export const STAFF_COMMAND_NAMES = Object.freeze([
  "staff.access.set",
  "staff.create",
  "staff.credentials.reset",
] as const);
export const STAFF_QUERY_NAMES = Object.freeze(["staff.access.list"] as const);
