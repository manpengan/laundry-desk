import { AiApprovalViewSchema, type AiApprovalView } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { PendingAction } from "../pending-actions/types.js";

export type ApprovalStatus = AiApprovalView["status"];

export type ApprovalRequest = Readonly<{
  approvalRef: string;
  orgId: string;
  storeId: string;
  pendingActionRef: string;
  command: string;
  commandVersion: string;
  args: PendingAction["args"];
  argsHash: string;
  entityVersions: PendingAction["entityVersions"];
  idempotencyKey: string;
  requesterStaffId: string;
  requesterPermissionVersion: number;
  status: ApprovalStatus;
  rowVersion: number;
  createdAt: number;
  expiresAt: number;
  decidedByStaffId: string | null;
  decidedByPermissionVersion: number | null;
  decidedAt: number | null;
  decisionReason: string | null;
  consumedAt: number | null;
}>;

export type ApprovalContext = Readonly<{ tenant: TenantContext; client?: SqlClient }>;
export type ApprovalTransaction = Readonly<{ tenant: TenantContext; client: SqlClient }>;

export class ApprovalStoreError extends Error {
  override readonly name = "ApprovalStoreError";

  constructor(
    readonly code:
      | "NOT_FOUND"
      | "INVALID_PENDING"
      | "SELF_APPROVE_FORBIDDEN"
      | "EXPIRED"
      | "VERSION_CONFLICT"
      | "ALREADY_DECIDED"
      | "AUTHORITY_CHANGED",
  ) {
    super(code);
  }
}

export type ApprovalStore = Readonly<{
  create(
    approvalRef: string,
    pending: PendingAction,
    requesterPermissionVersion: number,
    context: ApprovalTransaction,
  ): Promise<ApprovalRequest>;
  get(
    approvalRef: string,
    nowEpochSeconds: number,
    context: ApprovalContext,
  ): Promise<ApprovalRequest | null>;
  list(
    scope: "pending" | "history",
    limit: number,
    nowEpochSeconds: number,
    context: ApprovalContext,
  ): Promise<readonly ApprovalRequest[]>;
  decide(
    approvalRef: string,
    expectedVersion: number,
    decision: "approved" | "denied",
    reason: string | null,
    approverPermissionVersion: number,
    nowEpochSeconds: number,
    context: ApprovalTransaction,
  ): Promise<ApprovalRequest>;
  consume(
    approvalRef: string,
    pending: PendingAction,
    nowEpochSeconds: number,
    context: ApprovalTransaction,
  ): Promise<Readonly<{ approverStaffId: string; approval: ApprovalRequest }>>;
}>;

export function approvalView(request: ApprovalRequest, nowEpochSeconds: number): AiApprovalView {
  const status =
    request.status === "pending" && request.expiresAt <= nowEpochSeconds
      ? ("expired" as const)
      : request.status;
  return Object.freeze(
    AiApprovalViewSchema.parse({
      approval_ref: request.approvalRef,
      confirm_ref: request.pendingActionRef,
      command: request.command,
      command_version: request.commandVersion,
      args: request.args,
      args_hash: request.argsHash,
      entity_versions: Object.freeze(
        request.entityVersions.map((version) =>
          Object.freeze({
            entity_type: version.entityType,
            entity_id: version.entityId,
            version: version.version,
          }),
        ),
      ),
      idempotency_key: request.idempotencyKey,
      requester_staff_id: request.requesterStaffId,
      status,
      row_version: request.rowVersion,
      created_at_epoch: request.createdAt,
      expires_at_epoch: request.expiresAt,
      decided_by_staff_id: request.decidedByStaffId,
      decided_by_permission_version: request.decidedByPermissionVersion,
      decided_at_epoch: request.decidedAt,
      decision_reason: request.decisionReason,
      consumed_at_epoch: request.consumedAt,
    }),
  );
}
