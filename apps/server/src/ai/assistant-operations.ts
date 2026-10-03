import { LOCAL_PROFILE } from "../local/profile.js";
import { randomUUID } from "node:crypto";
import {
  AiOperationDraftSchema,
  AiOperationNameSchema,
  AiOperationPreviewSchema,
  FulfillmentOperationConfirmationSummarySchema,
  AiOperationResultSchema,
  type AiOperationDraft,
  type AiOperationPreview,
} from "@laundry/contracts";
import type { AuthorizedSession } from "../auth/session-view.js";
import { executeCommand } from "../bus/executor.js";
import { createRuntimeBus, permissionsForAuthority } from "../bus/runtime.js";
import { createSqlRunner, tenantFromSession } from "../http/bus-route-execution.js";
import { isRuntimeBusOperationAvailable } from "../http/runtime-surface-policy.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import { redactAiText, detectsPromptInjection } from "./safety-guard.js";
import type { AiRequestContext } from "./streaming-store.js";

function describe(draft: AiOperationDraft, barcodes: readonly string[]): string {
  if (draft.command === "garment.bulk_transition")
    return `衣物 ${barcodes.join("、")} 改为 ${draft.input.target_status === "ready" ? "待上架" : "洗涤中"}；备注：${draft.input.note ?? "无"}`;
  if (draft.command === "garment.rework")
    return `衣物 ${barcodes.join("、")} 返洗；原因：${draft.input.reason}`;
  return `仅生成手工联系 CSV，不发送消息。订单 ${draft.input.order_ids.join("、")}；${draft.input.min_age_days} 天；仅欠款 ${draft.input.unpaid_only}；状态 ${draft.input.garment_statuses.join("、")}；分组 ${draft.input.group_by}；模板：${draft.input.message_template}`;
}

export async function previewAssistantOperation(
  runtime: LocalRuntime,
  value: unknown,
  context: AiRequestContext,
  signal: AbortSignal,
): Promise<AiOperationPreview> {
  const draft = AiOperationDraftSchema.parse(value);
  if (
    context.tenant.orgId !== LOCAL_PROFILE.orgId ||
    context.tenant.storeId !== LOCAL_PROFILE.storeId
  )
    throw new Error("AI_OPERATION_DENIED");
  if (!context.permissions?.includes("ai_use") || signal.aborted)
    throw new Error("AI_OPERATION_DENIED");
  const text =
    draft.command === "garment.bulk_transition"
      ? (draft.input.note ?? "")
      : draft.command === "garment.rework"
        ? draft.input.reason
        : draft.input.message_template;
  if (redactAiText(text).redactionCount > 0 || detectsPromptInjection(text))
    throw new Error("AI_OPERATION_DENIED");
  const bus = createRuntimeBus(runtime);
  const result = await createSqlRunner(runtime)((sql) =>
    executeCommand(sql, context.tenant, draft.command, draft.input, {
      registry: bus.registry,
      chainHooks: bus.chainHooks,
      pendingStore: runtime.pendingStore,
      actor: {
        staffId: context.tenant.staffId,
        deviceId: context.deviceId,
        via: "ai",
        permissions: context.permissions ?? [],
        riskCap: "R3",
      },
      dryRun: true,
      idempotencyKey: randomUUID(),
    }),
  );
  if (signal.aborted) throw new Error("AI_ABORTED");
  if (result.ok || result.error.code !== "POLICY_CONFIRMATION_REQUIRED")
    throw new Error("AI_OPERATION_PREVIEW_DENIED");
  const detail = result.error.detail;
  const ref = detail !== undefined && "confirm_ref" in detail ? detail.confirm_ref : undefined;
  if (typeof ref !== "string") throw new Error("AI_OPERATION_PREVIEW_INVALID");
  const pending = await runtime.pendingStore.get(ref, { tenant: context.tenant });
  if (
    pending === null ||
    pending.creatorStaffId !== context.tenant.staffId ||
    pending.command !== draft.command ||
    pending.effectiveRisk !== "R3"
  )
    throw new Error("AI_OPERATION_PREVIEW_INVALID");
  const summary = detail !== undefined && "summary" in detail ? detail.summary : undefined;
  const barcodes =
    draft.command === "notification.manual_list.create"
      ? []
      : FulfillmentOperationConfirmationSummarySchema.parse(summary).barcodes;
  return AiOperationPreviewSchema.parse({
    command: draft.command,
    confirm_ref: ref,
    summary: describe(draft, barcodes),
    expires_at: new Date(pending.expiresAt * 1000).toISOString(),
  });
}

/** Human-only HTTP entry. The model never receives this capability or execution results. */
export async function confirmAssistantOperation(
  runtime: LocalRuntime,
  authorized: AuthorizedSession,
  confirmRef: string,
) {
  const tenant = tenantFromSession(authorized);
  const permissions = permissionsForAuthority(authorized.authority);
  if (!permissions.includes("ai_use")) throw new Error("AI_OPERATION_DENIED");
  const pending = await runtime.pendingStore.get(confirmRef, { tenant });
  if (
    pending === null ||
    pending.creatorStaffId !== tenant.staffId ||
    pending.policyOutcome !== "confirm" ||
    pending.effectiveRisk !== "R3"
  )
    throw new Error("AI_OPERATION_DENIED");
  const command = AiOperationNameSchema.parse(pending.command);
  AiOperationDraftSchema.parse({ command, input: pending.args });
  if (!isRuntimeBusOperationAvailable(authorized, "command", command))
    throw new Error("AI_OPERATION_DENIED");
  const bus = createRuntimeBus(runtime);
  const result = await createSqlRunner(runtime)((sql) =>
    executeCommand(
      sql,
      tenant,
      command,
      {},
      {
        registry: bus.registry,
        chainHooks: bus.chainHooks,
        pendingStore: runtime.pendingStore,
        idempotencyStore: runtime.idempotencyStore,
        confirmRef,
        actor: {
          staffId: tenant.staffId,
          deviceId: authorized.session.device_id,
          via: "ai",
          permissions,
          riskCap: "R3",
        },
        sessionBinding: {
          sessionId: authorized.session.session_id,
          sessionVersion: authorized.session.session_version,
        },
      },
    ),
  );
  if (!result.ok) return result;
  if (result.data.execution !== "executed") throw new Error("AI_OPERATION_INVALID_RESULT");
  const data = result.data.result as Readonly<{ csv?: unknown }>;
  return {
    ok: true as const,
    data: AiOperationResultSchema.parse({
      command,
      executed: true,
      ...(command === "notification.manual_list.create" ? { csv: data.csv } : {}),
    }),
  };
}
