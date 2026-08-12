import {
  FactoryBatchCancelInputSchema,
  FactoryBatchCreateInputSchema,
  FactoryHandoffBatchGetInputSchema,
  FactoryHandoffBatchGetResultSchema,
  FactoryHandoffBatchCancelResultSchema,
  FactoryHandoffBatchCreateResultSchema,
  FactoryHandoffBatchesListInputSchema,
  FactoryHandoffBatchesListResultSchema,
  FactoryHandoffCheckpointRecordInputSchema,
  FactoryHandoffCheckpointRecordResultSchema,
  FactoryHandoffConfirmationSummarySchema,
  FactoryHandoffDiscrepancyResolveInputSchema,
  FactoryHandoffDiscrepancyResolveResultSchema,
  FactoryQualityCheckRecordInputSchema,
  FactoryQualityCheckRecordResultSchema,
  createCommandError,
} from "@laundry/contracts";

import type { CommandHandler, HandlerContext, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import {
  assertFulfillmentEnabled,
  prepareFulfillmentWrite,
  requireDeviceId,
  type FulfillmentRuntimeDeps,
} from "./handler-support.js";
import type { FactoryConfirmationSummary } from "./factory-types.js";

type FactoryOperation = FactoryConfirmationSummary["operation"];

function frozenDigest(context: HandlerContext, operation: FactoryOperation): string | undefined {
  if (context.request.confirmRef === undefined) return undefined;
  const parsed = FactoryHandoffConfirmationSummarySchema.safeParse(context.confirmationAuthority);
  if (!parsed.success || parsed.data.operation !== operation) {
    throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
  }
  return parsed.data.manifest_digest;
}

function frozenOrAbsent(context: HandlerContext, operation: FactoryOperation) {
  const digest = frozenDigest(context, operation);
  return digest === undefined
    ? Object.freeze({})
    : Object.freeze({ expected_manifest_digest: digest });
}

async function auditManifestIds(
  deps: FulfillmentRuntimeDeps,
  context: HandlerContext,
  batchId: string,
): Promise<readonly string[]> {
  const detail = await deps.store.getFactoryBatch(
    context.tenant.orgId,
    context.tenant.storeId,
    batchId,
  );
  if (detail === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  return Object.freeze(detail.manifest.map((row) => row.garment_id).sort());
}

function outcome(
  result: unknown,
  eventType: string,
  garmentIds: readonly string[],
  auditDetail: Readonly<Record<string, unknown>> = Object.freeze({}),
): HandlerOutcome {
  const record = result as Readonly<{
    batch_id: string;
    status: string;
    version: number;
    manifest_digest: string;
    matched_count?: number;
    missing_count?: number;
    unexpected_count?: number;
    pass_count?: number;
    rework_count?: number;
  }>;
  const counts = Object.freeze({
    ...(record.matched_count === undefined ? {} : { matched_count: record.matched_count }),
    ...(record.missing_count === undefined ? {} : { missing_count: record.missing_count }),
    ...(record.unexpected_count === undefined ? {} : { unexpected_count: record.unexpected_count }),
    ...(record.pass_count === undefined ? {} : { pass_count: record.pass_count }),
    ...(record.rework_count === undefined ? {} : { rework_count: record.rework_count }),
  });
  return Object.freeze({
    result,
    audit: Object.freeze({
      entity: "garment_batch",
      entityId: record.batch_id,
      afterJson: JSON.stringify({
        garment_ids: garmentIds,
        status: record.status,
        version: record.version,
        ...auditDetail,
        counts,
        manifest_digest: record.manifest_digest,
      }),
    }),
    events: Object.freeze([
      Object.freeze({
        type: eventType,
        payload: Object.freeze({
          batch_id: record.batch_id,
          status: record.status,
          version: record.version,
          counts,
          manifest_digest: record.manifest_digest,
        }),
      }),
    ]),
  });
}

function createHandler(deps: FulfillmentRuntimeDeps): CommandHandler {
  return async (context) => {
    const deviceId = requireDeviceId(context.actor.deviceId);
    const input = FactoryBatchCreateInputSchema.parse(context.parsed);
    const at = await prepareFulfillmentWrite(deps, context);
    const result = await deps.store.createFactoryBatch({
      ...input,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      device_id: deviceId,
      at,
      ...frozenOrAbsent(context, "batch_create"),
    });
    if (result === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    return outcome(
      FactoryHandoffBatchCreateResultSchema.parse(result),
      "fulfillment.batch_created",
      Object.freeze([...input.garment_ids].sort()),
    );
  };
}

function cancelHandler(deps: FulfillmentRuntimeDeps): CommandHandler {
  return async (context) => {
    const deviceId = requireDeviceId(context.actor.deviceId);
    const input = FactoryBatchCancelInputSchema.parse(context.parsed);
    const at = await prepareFulfillmentWrite(deps, context);
    const result = await deps.store.cancelFactoryBatch({
      ...input,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      device_id: deviceId,
      at,
      ...frozenOrAbsent(context, "batch_cancel"),
    });
    if (result === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    const parsed = FactoryHandoffBatchCancelResultSchema.parse(result);
    return outcome(
      parsed,
      "fulfillment.batch_cancelled",
      await auditManifestIds(deps, context, parsed.batch_id),
      Object.freeze({ reason_code: input.reason_code }),
    );
  };
}

function checkpointHandler(deps: FulfillmentRuntimeDeps): CommandHandler {
  return async (context) => {
    const deviceId = requireDeviceId(context.actor.deviceId);
    const input = FactoryHandoffCheckpointRecordInputSchema.parse(context.parsed);
    const at = await prepareFulfillmentWrite(deps, context);
    const result = await deps.store.recordFactoryCheckpoint({
      ...input,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      device_id: deviceId,
      at,
      ...frozenOrAbsent(context, "checkpoint_record"),
    });
    if (result === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    return outcome(
      FactoryHandoffCheckpointRecordResultSchema.parse(result),
      "fulfillment.handoff_attempt_recorded",
      Object.freeze([...input.garment_ids].sort()),
    );
  };
}

function resolveHandler(deps: FulfillmentRuntimeDeps): CommandHandler {
  return async (context) => {
    const deviceId = requireDeviceId(context.actor.deviceId);
    const input = FactoryHandoffDiscrepancyResolveInputSchema.parse(context.parsed);
    const at = await prepareFulfillmentWrite(deps, context);
    const result = await deps.store.resolveFactoryDiscrepancy({
      ...input,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      device_id: deviceId,
      at,
      ...frozenOrAbsent(context, "discrepancy_resolve"),
    });
    if (result === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    const parsed = FactoryHandoffDiscrepancyResolveResultSchema.parse(result);
    return outcome(
      parsed,
      "fulfillment.handoff_discrepancy_resolved",
      await auditManifestIds(deps, context, parsed.batch_id),
    );
  };
}

function qualityHandler(deps: FulfillmentRuntimeDeps): CommandHandler {
  return async (context) => {
    const deviceId = requireDeviceId(context.actor.deviceId);
    const input = FactoryQualityCheckRecordInputSchema.parse(context.parsed);
    const at = await prepareFulfillmentWrite(deps, context);
    const result = await deps.store.recordFactoryQuality({
      ...input,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      device_id: deviceId,
      at,
      ...frozenOrAbsent(context, "quality_check"),
    });
    if (result === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    return outcome(
      FactoryQualityCheckRecordResultSchema.parse(result),
      "fulfillment.quality_checked",
      Object.freeze([...input.garment_ids].sort()),
    );
  };
}

function listHandler(deps: FulfillmentRuntimeDeps): CommandHandler {
  return async (context) => {
    await assertFulfillmentEnabled(deps, context);
    const input = FactoryHandoffBatchesListInputSchema.parse(context.parsed);
    const result = await deps.store.listFactoryBatches(
      context.tenant.orgId,
      context.tenant.storeId,
      Object.freeze({
        ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
        limit: input.limit ?? 20,
      }),
    );
    return Object.freeze({ result: FactoryHandoffBatchesListResultSchema.parse(result) });
  };
}

function getHandler(deps: FulfillmentRuntimeDeps): CommandHandler {
  return async (context) => {
    await assertFulfillmentEnabled(deps, context);
    const input = FactoryHandoffBatchGetInputSchema.parse(context.parsed);
    const result = await deps.store.getFactoryBatch(
      context.tenant.orgId,
      context.tenant.storeId,
      input.batch_id,
    );
    if (result === null) throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    return Object.freeze({ result: FactoryHandoffBatchGetResultSchema.parse(result) });
  };
}

export function registerFactoryCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: FulfillmentRuntimeDeps,
): void {
  registry.registerHandler("fulfillment.batch.create", createHandler(deps));
  registry.registerHandler("fulfillment.batch.cancel", cancelHandler(deps));
  registry.registerHandler("fulfillment.handoff.checkpoint.record", checkpointHandler(deps));
  registry.registerHandler("fulfillment.handoff.discrepancy.resolve", resolveHandler(deps));
  registry.registerHandler("fulfillment.quality_check.record", qualityHandler(deps));
}

export function registerFactoryQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: FulfillmentRuntimeDeps,
): void {
  registry.registerHandler("fulfillment.batches.list", listHandler(deps));
  registry.registerHandler("fulfillment.batch.get", getHandler(deps));
}
