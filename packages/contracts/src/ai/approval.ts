import { z } from "zod";

const CommandNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/);

export const AiApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
]);
export const AiApprovalRefSchema = z.uuid();

export const AiApprovalEntityVersionSchema = z
  .object({
    entity_type: z.string().min(1).max(64),
    entity_id: z.string().min(1).max(128),
    version: z.number().int().nonnegative(),
  })
  .strict();

export const AiApprovalRequestSchema = z.object({ confirm_ref: z.uuid() }).strict();

export const AiApprovalListQuerySchema = z
  .object({
    status: z.enum(["pending", "history"]).default("pending"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const AiApprovalDecisionSchema = z
  .object({ expected_version: z.number().int().positive() })
  .strict();

export const AiApprovalDenialSchema = z
  .object({
    expected_version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const AiApprovalViewSchema = z
  .object({
    approval_ref: AiApprovalRefSchema,
    confirm_ref: z.uuid(),
    command: CommandNameSchema,
    command_version: z.string().min(1).max(32),
    args: z.json(),
    args_hash: z.string().regex(/^[0-9a-f]{64}$/),
    entity_versions: z.array(AiApprovalEntityVersionSchema).max(100),
    idempotency_key: z.uuid(),
    requester_staff_id: z.uuid(),
    status: AiApprovalStatusSchema,
    row_version: z.number().int().positive(),
    created_at_epoch: z.number().int().nonnegative(),
    expires_at_epoch: z.number().int().nonnegative(),
    decided_by_staff_id: z.uuid().nullable(),
    decided_by_permission_version: z.number().int().positive().nullable(),
    decided_at_epoch: z.number().int().nonnegative().nullable(),
    decision_reason: z.string().max(500).nullable(),
    consumed_at_epoch: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const AiApprovalItemResponseSchema = z
  .object({ ok: z.literal(true), data: AiApprovalViewSchema })
  .strict();

export const AiApprovalListResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ items: z.array(AiApprovalViewSchema) }).strict(),
  })
  .strict();

export const AiApprovalExecutionResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        approval: AiApprovalViewSchema,
        execution: z.literal("executed"),
        result: z.json(),
      })
      .strict(),
  })
  .strict();

type AiApprovalOperationRow = Readonly<{
  operation: "submit" | "list" | "detail" | "approve" | "deny";
  method: "GET" | "POST";
  path: string;
  permission: "approval_manage" | "authenticated";
  risk: "R0" | "R4";
  csrf: boolean;
}>;

export const AI_APPROVAL_OPERATION_MATRIX = Object.freeze([
  Object.freeze({
    operation: "submit" as const,
    method: "POST" as const,
    path: "/api/v2/ai/approval-requests" as const,
    permission: "authenticated" as const,
    risk: "R4" as const,
    csrf: true,
  }),
  Object.freeze({
    operation: "list" as const,
    method: "GET" as const,
    path: "/api/v2/ai/approval-requests" as const,
    permission: "approval_manage" as const,
    risk: "R0" as const,
    csrf: false,
  }),
  Object.freeze({
    operation: "detail" as const,
    method: "GET" as const,
    path: "/api/v2/ai/approval-requests/{approval_ref}" as const,
    permission: "approval_manage" as const,
    risk: "R0" as const,
    csrf: false,
  }),
  Object.freeze({
    operation: "approve" as const,
    method: "POST" as const,
    path: "/api/v2/ai/approval-requests/{approval_ref}/approve" as const,
    permission: "approval_manage" as const,
    risk: "R4" as const,
    csrf: true,
  }),
  Object.freeze({
    operation: "deny" as const,
    method: "POST" as const,
    path: "/api/v2/ai/approval-requests/{approval_ref}/deny" as const,
    permission: "approval_manage" as const,
    risk: "R4" as const,
    csrf: true,
  }),
] as const satisfies readonly AiApprovalOperationRow[]);

export type AiApprovalView = Readonly<z.output<typeof AiApprovalViewSchema>>;
export type AiApprovalListQuery = Readonly<z.output<typeof AiApprovalListQuerySchema>>;
