import { randomUUID } from "node:crypto";

import { writeAudit, type AuditWriteRecord } from "../audit/write-audit.js";
import type { SqlClient } from "../db/types.js";
import type { AuditWriteInput, BusContext } from "./types.js";

export type ApprovalAuditEvidence = Readonly<{
  initiatedByStaffId: string;
  approvedByStaffId: string;
}>;

export async function writeAuditForOutcome(
  client: SqlClient,
  context: BusContext,
  audit: AuditWriteInput | undefined,
  options: Readonly<{ now?: () => Date; newId?: () => string }>,
  approval: ApprovalAuditEvidence | undefined = undefined,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const record: AuditWriteRecord = {
    id: newId(),
    orgId: context.tenant.orgId,
    storeId: context.tenant.storeId,
    staffId: context.actor.staffId,
    via: context.actor.via,
    command: context.request.name,
    idempotencyKey: context.request.idempotencyKey ?? null,
    dryRun: false,
    entity: audit?.entity ?? null,
    entityId: audit?.entityId ?? null,
    beforeJson: audit?.beforeJson ?? null,
    afterJson: withApprovalEvidence(audit?.afterJson ?? null, approval),
    ip: audit?.ip ?? null,
    deviceId: context.actor.deviceId,
    at: now(),
  };
  await writeAudit(client, record);
}

function withApprovalEvidence(
  afterJson: string | null,
  approval: ApprovalAuditEvidence | undefined,
): string | null {
  if (approval === undefined) return afterJson;
  const parsed: unknown = afterJson === null ? {} : JSON.parse(afterJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Approval audit requires an object after_json");
  }
  return JSON.stringify(
    Object.freeze({
      ...(parsed as Readonly<Record<string, unknown>>),
      initiated_by_staff_id: approval.initiatedByStaffId,
      approved_by_staff_id: approval.approvedByStaffId,
    }),
  );
}
