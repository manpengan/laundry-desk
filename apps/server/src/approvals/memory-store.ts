import { registerMemoryRollback } from "../db/memory-unit-of-work.js";
import type { PendingAction } from "../pending-actions/types.js";
import {
  ApprovalStoreError,
  type ApprovalRequest,
  type ApprovalStore,
  type ApprovalTransaction,
} from "./types.js";

const freezeRequest = (request: ApprovalRequest): ApprovalRequest => Object.freeze({ ...request });

export class MemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRequest>();

  async create(
    approvalRef: string,
    pending: PendingAction,
    requesterPermissionVersion: number,
    context: ApprovalTransaction,
  ): Promise<ApprovalRequest> {
    if (
      pending.orgId !== context.tenant.orgId ||
      pending.storeId !== context.tenant.storeId ||
      pending.creatorStaffId !== context.tenant.staffId ||
      pending.status !== "pending" ||
      pending.effectiveRisk !== "R4" ||
      pending.policyOutcome !== "step_up" ||
      !pending.requiresOtherApprover
    ) {
      throw new ApprovalStoreError("INVALID_PENDING");
    }
    const existing = [...this.records.values()].find(
      (request) =>
        request.orgId === pending.orgId &&
        request.storeId === pending.storeId &&
        request.pendingActionRef === pending.nonce,
    );
    if (existing !== undefined) return existing;
    const request = freezeRequest({
      approvalRef,
      orgId: pending.orgId,
      storeId: pending.storeId,
      pendingActionRef: pending.nonce,
      command: pending.command,
      commandVersion: pending.commandVersion,
      args: pending.args,
      argsHash: pending.argsHash,
      entityVersions: pending.entityVersions,
      idempotencyKey: pending.idempotencyKey,
      requesterStaffId: pending.creatorStaffId,
      requesterPermissionVersion,
      status: "pending",
      rowVersion: 1,
      createdAt: Math.floor(Date.now() / 1_000),
      expiresAt: pending.expiresAt,
      decidedByStaffId: null,
      decidedByPermissionVersion: null,
      decidedAt: null,
      decisionReason: null,
      consumedAt: null,
    });
    this.records.set(approvalRef, request);
    this.restoreOnRollback(approvalRef, null, request);
    return request;
  }

  async get(
    approvalRef: string,
    _nowEpochSeconds: number,
    context: Readonly<{ tenant: ApprovalTransaction["tenant"] }>,
  ): Promise<ApprovalRequest | null> {
    const request = this.records.get(approvalRef);
    return request !== undefined &&
      request.orgId === context.tenant.orgId &&
      request.storeId === context.tenant.storeId
      ? request
      : null;
  }

  async list(
    scope: "pending" | "history",
    limit: number,
    nowEpochSeconds: number,
    context: Readonly<{ tenant: ApprovalTransaction["tenant"] }>,
  ): Promise<readonly ApprovalRequest[]> {
    return Object.freeze(
      [...this.records.values()]
        .filter(
          (request) =>
            request.orgId === context.tenant.orgId &&
            request.storeId === context.tenant.storeId &&
            (scope === "pending"
              ? request.status === "pending" && request.expiresAt > nowEpochSeconds
              : request.status !== "pending" || request.expiresAt <= nowEpochSeconds),
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, limit),
    );
  }

  async decide(
    approvalRef: string,
    expectedVersion: number,
    decision: "approved" | "denied",
    reason: string | null,
    approverPermissionVersion: number,
    nowEpochSeconds: number,
    context: ApprovalTransaction,
  ): Promise<ApprovalRequest> {
    const current = this.records.get(approvalRef);
    if (current === undefined) throw new ApprovalStoreError("NOT_FOUND");
    if (current.orgId !== context.tenant.orgId || current.storeId !== context.tenant.storeId) {
      throw new ApprovalStoreError("NOT_FOUND");
    }
    if (current.requesterStaffId === context.tenant.staffId) {
      throw new ApprovalStoreError("SELF_APPROVE_FORBIDDEN");
    }
    if (current.rowVersion !== expectedVersion) throw new ApprovalStoreError("VERSION_CONFLICT");
    if (current.status !== "pending") throw new ApprovalStoreError("ALREADY_DECIDED");
    if (current.expiresAt <= nowEpochSeconds) {
      const expired = freezeRequest({
        ...current,
        status: "expired",
        rowVersion: current.rowVersion + 1,
      });
      this.records.set(approvalRef, expired);
      this.restoreOnRollback(approvalRef, current, expired);
      throw new ApprovalStoreError("EXPIRED");
    }
    const decided = freezeRequest({
      ...current,
      status: decision,
      rowVersion: current.rowVersion + 1,
      decidedByStaffId: context.tenant.staffId,
      decidedByPermissionVersion: approverPermissionVersion,
      decidedAt: nowEpochSeconds,
      decisionReason: decision === "denied" ? reason : null,
    });
    this.records.set(approvalRef, decided);
    this.restoreOnRollback(approvalRef, current, decided);
    return decided;
  }

  async consume(
    approvalRef: string,
    pending: PendingAction,
    nowEpochSeconds: number,
    context: ApprovalTransaction,
  ): Promise<Readonly<{ approverStaffId: string; approval: ApprovalRequest }>> {
    const current = this.records.get(approvalRef);
    if (
      current === undefined ||
      current.status !== "approved" ||
      current.orgId !== context.tenant.orgId ||
      current.storeId !== context.tenant.storeId ||
      current.requesterStaffId !== context.tenant.staffId ||
      current.pendingActionRef !== pending.nonce ||
      current.argsHash !== pending.argsHash ||
      JSON.stringify(current.entityVersions) !== JSON.stringify(pending.entityVersions) ||
      current.idempotencyKey !== pending.idempotencyKey
    ) {
      throw new ApprovalStoreError("AUTHORITY_CHANGED");
    }
    if (current.expiresAt <= nowEpochSeconds) throw new ApprovalStoreError("EXPIRED");
    if (current.decidedByStaffId === null) throw new ApprovalStoreError("AUTHORITY_CHANGED");
    const consumed = freezeRequest({
      ...current,
      status: "consumed",
      rowVersion: current.rowVersion + 1,
      consumedAt: nowEpochSeconds,
    });
    this.records.set(approvalRef, consumed);
    this.restoreOnRollback(approvalRef, current, consumed);
    return Object.freeze({ approverStaffId: current.decidedByStaffId, approval: consumed });
  }

  private restoreOnRollback(
    approvalRef: string,
    before: ApprovalRequest | null,
    after: ApprovalRequest,
  ): void {
    registerMemoryRollback(() => {
      if (this.records.get(approvalRef) !== after) return;
      if (before === null) this.records.delete(approvalRef);
      else this.records.set(approvalRef, before);
    });
  }
}
