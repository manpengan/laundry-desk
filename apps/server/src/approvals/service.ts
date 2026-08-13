import { randomUUID } from "node:crypto";

import type { AiApprovalListQuery, AiApprovalView } from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import { loadSessionStaffAuthority } from "../auth/session-view.js";
import { writeAudit } from "../audit/write-audit.js";
import { executeCommand } from "../bus/executor.js";
import { createRuntimeBus, permissionsForAuthority } from "../bus/runtime.js";
import type { CommandResult } from "../bus/types.js";
import type { TenantContext } from "../db/types.js";
import type { PendingAction } from "../pending-actions/types.js";
import { ApprovalStoreError, approvalView, type ApprovalRequest } from "./types.js";
import type { ApprovalRuntime } from "./runtime.js";

export class ApprovalServiceError extends Error {
  override readonly name = "ApprovalServiceError";

  constructor(
    readonly code:
      "NOT_FOUND" | "POLICY_DENIED" | "PERMISSION_DENIED" | "INVARIANT_FAILED" | "VERSION_CONFLICT",
  ) {
    super(code);
  }
}

function tenantOf(authorized: AuthorizedSession): TenantContext {
  return Object.freeze({
    orgId: authorized.session.org_id,
    storeId: authorized.session.store_id,
    staffId: authorized.session.staff_id,
  });
}

function mapStoreError(error: unknown): never {
  if (!(error instanceof ApprovalStoreError)) throw error;
  if (error.code === "NOT_FOUND") throw new ApprovalServiceError("NOT_FOUND");
  if (error.code === "VERSION_CONFLICT" || error.code === "ALREADY_DECIDED") {
    throw new ApprovalServiceError("VERSION_CONFLICT");
  }
  if (error.code === "SELF_APPROVE_FORBIDDEN") {
    throw new ApprovalServiceError("PERMISSION_DENIED");
  }
  if (error.code === "EXPIRED") throw new ApprovalServiceError("INVARIANT_FAILED");
  throw new ApprovalServiceError("POLICY_DENIED");
}

function assertPendingR4(
  pending: PendingAction | null,
  authorized: AuthorizedSession,
): PendingAction {
  if (
    pending === null ||
    pending.creatorStaffId !== authorized.session.staff_id ||
    pending.status !== "pending" ||
    pending.effectiveRisk !== "R4" ||
    pending.policyOutcome !== "step_up" ||
    !pending.requiresOtherApprover
  ) {
    throw new ApprovalServiceError("POLICY_DENIED");
  }
  return pending;
}

async function auditApproval(
  context: Readonly<{ client: import("../db/types.js").SqlClient; tenant: TenantContext }>,
  authorized: AuthorizedSession,
  request: ApprovalRequest,
  action: "request" | "approve" | "deny",
  now: Date,
): Promise<void> {
  await writeAudit(context.client, {
    id: randomUUID(),
    orgId: context.tenant.orgId,
    storeId: context.tenant.storeId,
    staffId: context.tenant.staffId,
    via: "ui",
    command: `ai.approval.${action}`,
    idempotencyKey: request.idempotencyKey,
    dryRun: false,
    entity: "ai_approval_request",
    entityId: request.approvalRef,
    beforeJson: null,
    afterJson: JSON.stringify(
      Object.freeze({
        approval_ref: request.approvalRef,
        confirm_ref: request.pendingActionRef,
        command: request.command,
        status: request.status,
        row_version: request.rowVersion,
        requester_staff_id: request.requesterStaffId,
        actor_staff_id: authorized.session.staff_id,
      }),
    ),
    ip: null,
    deviceId: authorized.session.device_id,
    at: now,
  });
}

export type ApprovalExecution = Readonly<{
  approval: AiApprovalView;
  commandResult: CommandResult;
}>;

export type ApprovalService = ReturnType<typeof createApprovalService>;

export function createApprovalService(
  runtime: ApprovalRuntime,
  clock: () => Date = () => new Date(),
) {
  const nowEpoch = (): number => Math.floor(clock().getTime() / 1_000);

  const submit = async (
    authorized: AuthorizedSession,
    confirmRef: string,
  ): Promise<AiApprovalView> => {
    const tenant = tenantOf(authorized);
    try {
      const request = await runtime.transact(tenant, async (context) => {
        const pending = assertPendingR4(
          await runtime.local.pendingStore.get(confirmRef, context),
          authorized,
        );
        if (pending.expiresAt <= nowEpoch()) throw new ApprovalServiceError("INVARIANT_FAILED");
        const created = await runtime.store.create(
          randomUUID(),
          pending,
          authorized.authority.permission_version,
          context,
        );
        await auditApproval(context, authorized, created, "request", clock());
        return created;
      });
      return approvalView(request, nowEpoch());
    } catch (error) {
      mapStoreError(error);
    }
  };

  const list = async (
    authorized: AuthorizedSession,
    query: AiApprovalListQuery,
  ): Promise<readonly AiApprovalView[]> => {
    const tenant = tenantOf(authorized);
    const now = nowEpoch();
    const items = await runtime.store.list(query.status, query.limit, now, { tenant });
    return Object.freeze(items.map((item) => approvalView(item, now)));
  };

  const get = async (
    authorized: AuthorizedSession,
    approvalRef: string,
  ): Promise<AiApprovalView> => {
    const now = nowEpoch();
    const request = await runtime.store.get(approvalRef, now, { tenant: tenantOf(authorized) });
    if (request === null) throw new ApprovalServiceError("NOT_FOUND");
    return approvalView(request, now);
  };

  const decide = async (
    authorized: AuthorizedSession,
    approvalRef: string,
    expectedVersion: number,
    decision: "approved" | "denied",
    reason: string | null,
  ): Promise<ApprovalRequest> => {
    if (authorized.authority.role !== "admin") {
      throw new ApprovalServiceError("PERMISSION_DENIED");
    }
    const tenant = tenantOf(authorized);
    try {
      return await runtime.transact(tenant, async (context) => {
        const request = await runtime.store.decide(
          approvalRef,
          expectedVersion,
          decision,
          reason,
          authorized.authority.permission_version,
          nowEpoch(),
          context,
        );
        await auditApproval(
          context,
          authorized,
          request,
          decision === "approved" ? "approve" : "deny",
          clock(),
        );
        return request;
      });
    } catch (error) {
      mapStoreError(error);
    }
  };

  const deny = async (
    authorized: AuthorizedSession,
    approvalRef: string,
    expectedVersion: number,
    reason: string,
  ): Promise<AiApprovalView> =>
    approvalView(
      await decide(authorized, approvalRef, expectedVersion, "denied", reason),
      nowEpoch(),
    );

  const approveAndExecute = async (
    authorized: AuthorizedSession,
    approvalRef: string,
    expectedVersion: number,
  ): Promise<ApprovalExecution> => {
    if (authorized.authority.role !== "admin") {
      throw new ApprovalServiceError("PERMISSION_DENIED");
    }
    const existing = await runtime.store.get(approvalRef, nowEpoch(), {
      tenant: tenantOf(authorized),
    });
    let approved: ApprovalRequest;
    if (
      existing?.status === "approved" &&
      existing.decidedByStaffId === authorized.session.staff_id
    ) {
      if (existing.rowVersion !== expectedVersion) {
        throw new ApprovalServiceError("VERSION_CONFLICT");
      }
      if (existing.decidedByPermissionVersion !== authorized.authority.permission_version) {
        throw new ApprovalServiceError("POLICY_DENIED");
      }
      approved = existing;
    } else {
      approved = await decide(authorized, approvalRef, expectedVersion, "approved", null);
    }
    const requester = await loadSessionStaffAuthority(runtime.local, {
      org_id: approved.orgId,
      store_id: approved.storeId,
      staff_id: approved.requesterStaffId,
      permission_version: approved.requesterPermissionVersion,
    });
    if (requester === null) throw new ApprovalServiceError("POLICY_DENIED");
    const { registry, chainHooks } = createRuntimeBus(runtime.local);
    const commandResult = await runtime.withSql((client) =>
      executeCommand(
        client,
        Object.freeze({
          orgId: approved.orgId,
          storeId: approved.storeId,
          staffId: approved.requesterStaffId,
        }),
        approved.command,
        Object.freeze({}),
        {
          registry,
          chainHooks,
          actor: Object.freeze({
            staffId: approved.requesterStaffId,
            deviceId: null,
            via: "ai" as const,
            permissions: permissionsForAuthority(requester),
            riskCap: "R4" as const,
          }),
          confirmRef: approved.pendingActionRef,
          pendingStore: runtime.local.pendingStore,
          approvalStore: runtime.store,
          approvalRef,
          idempotencyStore: runtime.local.idempotencyStore,
          now: clock,
        },
      ),
    );
    const finalRequest = await runtime.store.get(approvalRef, nowEpoch(), {
      tenant: Object.freeze({
        orgId: approved.orgId,
        storeId: approved.storeId,
        staffId: approved.requesterStaffId,
      }),
    });
    if (finalRequest === null) throw new ApprovalServiceError("NOT_FOUND");
    return Object.freeze({ approval: approvalView(finalRequest, nowEpoch()), commandResult });
  };

  return Object.freeze({ submit, list, get, deny, approveAndExecute });
}
