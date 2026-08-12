import type { RiskLevel } from "@laundry/domain";

import type { PolicyOutcome } from "../policy/types.js";
import { freezeCanonical, hashCanonical } from "./canonical.js";
import { freezeEntityVersions, freezePendingAction } from "./store.js";
import type { EntityVersion, PendingAction, PendingActionStatus } from "./types.js";

export type PendingActionRow = Readonly<{
  nonce: string;
  command: string;
  command_version: string;
  args_json: unknown;
  authority_json: unknown | null;
  authority_present: boolean;
  args_hash: string;
  entity_versions_json: unknown;
  creator_staff_id: string;
  org_id: string;
  store_id: string;
  idempotency_key: string;
  privacy_subject_customer_id: string | null;
  created_at_epoch: string | number;
  expires_at_epoch: string | number;
  status: string;
  effective_risk: string;
  policy_outcome: string;
  requires_other_approver: boolean;
  consumed_by_staff_id: string | null;
  consumed_at_epoch: string | number | null;
}>;

export type PendingActionWithClockRow = PendingActionRow &
  Readonly<{ database_now_epoch: string | number }>;

export const SELECT_COLUMNS = `nonce::text, command, command_version, args_json,
  authority_json, authority_present, args_hash, entity_versions_json,
  creator_staff_id::text, org_id::text, store_id::text, idempotency_key::text,
  privacy_subject_customer_id::text,
  created_at_epoch, expires_at_epoch, status, effective_risk, policy_outcome,
  requires_other_approver, consumed_by_staff_id::text, consumed_at_epoch`;

export function pendingEpoch(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Persisted pending action ${field} is invalid`);
  }
  return parsed;
}

function status(value: string): PendingActionStatus {
  if (value === "pending" || value === "consumed" || value === "expired" || value === "denied") {
    return value;
  }
  throw new Error("Persisted pending action status is invalid");
}

function risk(value: string): RiskLevel {
  if (
    value === "R0" ||
    value === "R1" ||
    value === "R2" ||
    value === "R3" ||
    value === "R4" ||
    value === "R5"
  ) {
    return value;
  }
  throw new Error("Persisted pending action risk is invalid");
}

function policyOutcome(value: string): Extract<PolicyOutcome, "confirm" | "step_up"> {
  if (value === "confirm" || value === "step_up") return value;
  throw new Error("Persisted pending action policy outcome is invalid");
}

function entityVersions(value: unknown): readonly EntityVersion[] {
  if (!Array.isArray(value)) {
    throw new Error("Persisted pending action entity versions are invalid");
  }
  return freezeEntityVersions(
    value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Persisted pending action entity version is invalid");
      }
      const record = entry as Readonly<Record<string, unknown>>;
      if (
        typeof record.entityType !== "string" ||
        typeof record.entityId !== "string" ||
        typeof record.version !== "number" ||
        !Number.isSafeInteger(record.version) ||
        record.version < 0
      ) {
        throw new Error("Persisted pending action entity version is invalid");
      }
      return Object.freeze({
        entityType: record.entityType,
        entityId: record.entityId,
        version: record.version,
      });
    }),
  );
}

export function actionFromRow(row: PendingActionRow): PendingAction {
  const args = freezeCanonical(row.args_json);
  const authority = row.authority_present ? freezeCanonical(row.authority_json) : undefined;
  const calculatedHash = hashCanonical(
    authority === undefined ? args : Object.freeze({ args, authority }),
  );
  if (calculatedHash !== row.args_hash) {
    throw new Error("Persisted pending action hash is invalid");
  }
  const parsedStatus = status(row.status);
  const consumedAt =
    row.consumed_at_epoch === null
      ? null
      : pendingEpoch(row.consumed_at_epoch, "consumed_at_epoch");
  if (
    (parsedStatus === "consumed" && (row.consumed_by_staff_id === null || consumedAt === null)) ||
    (parsedStatus !== "consumed" && (row.consumed_by_staff_id !== null || consumedAt !== null))
  ) {
    throw new Error("Persisted pending action consumption state is invalid");
  }
  return freezePendingAction({
    nonce: row.nonce,
    command: row.command,
    commandVersion: row.command_version,
    args,
    ...(authority === undefined ? {} : { authority }),
    argsHash: row.args_hash,
    entityVersions: entityVersions(row.entity_versions_json),
    creatorStaffId: row.creator_staff_id,
    orgId: row.org_id,
    storeId: row.store_id,
    idempotencyKey: row.idempotency_key,
    privacySubjectCustomerId: row.privacy_subject_customer_id,
    createdAt: pendingEpoch(row.created_at_epoch, "created_at_epoch"),
    expiresAt: pendingEpoch(row.expires_at_epoch, "expires_at_epoch"),
    status: parsedStatus,
    effectiveRisk: risk(row.effective_risk),
    policyOutcome: policyOutcome(row.policy_outcome),
    requiresOtherApprover: row.requires_other_approver,
    consumedByStaffId: row.consumed_by_staff_id,
    consumedAt,
  });
}
