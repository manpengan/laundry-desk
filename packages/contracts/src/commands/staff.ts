import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

export const StaffAccessListInputSchema = z.strictObject({});

export const StaffAccessSetInputSchema = z
  .strictObject({
    target_staff_id: z.uuid(),
    expected_permission_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    role: z.enum(["admin", "staff"]),
    privacy_admin: z.boolean(),
    is_active: z.boolean(),
    reason: z.string().trim().min(1).max(256),
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

export const STAFF_COMMANDS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  staffAccessSetCommand,
]);

export const STAFF_QUERIES: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  staffAccessListQuery,
]);

export const STAFF_DEFINITIONS = Object.freeze([...STAFF_COMMANDS, ...STAFF_QUERIES]);
export const STAFF_COMMAND_NAMES = Object.freeze(["staff.access.set"] as const);
export const STAFF_QUERY_NAMES = Object.freeze(["staff.access.list"] as const);
