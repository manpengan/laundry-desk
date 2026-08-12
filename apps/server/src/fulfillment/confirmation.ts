import {
  FactoryBatchCancelInputSchema,
  FactoryBatchCreateInputSchema,
  FactoryHandoffCheckpointRecordInputSchema,
  FactoryHandoffConfirmationSummarySchema,
  FactoryHandoffDiscrepancyResolveInputSchema,
  FactoryQualityCheckRecordInputSchema,
  FulfillmentOperationConfirmationSummarySchema,
  GarmentBulkTransitionInputSchema,
  GarmentIncidentRecordInputSchema,
  GarmentMarkLostInputSchema,
  GarmentReworkInputSchema,
  createCommandError,
} from "@laundry/contracts";

import { HandlerCommandError } from "../bus/types.js";
import type { PendingActionPreparer } from "../handlers/default-chain-hooks.js";
import {
  prepareFulfillmentWrite,
  requireDeviceId,
  type FulfillmentRuntimeDeps,
} from "./handler-support.js";
import type {
  FactoryCancelInput,
  FactoryCheckpointInput,
  FactoryCreateInput,
  FactoryPreparationInput,
  FactoryQualityInput,
  FactoryResolveInput,
} from "./factory-types.js";
import type { FulfillmentConfirmationRequest } from "./types.js";

function scope(deps: FulfillmentRuntimeDeps, context: Parameters<PendingActionPreparer>[1]) {
  const deviceId = requireDeviceId(context.actor.deviceId);
  return prepareFulfillmentWrite(deps, context).then((at) =>
    Object.freeze({
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      device_id: deviceId,
      at,
    }),
  );
}

async function factoryRequest(
  deps: FulfillmentRuntimeDeps,
  parsed: unknown,
  context: Parameters<PendingActionPreparer>[1],
): Promise<FactoryPreparationInput | null> {
  const base = await scope(deps, context);
  switch (context.definition.name) {
    case "fulfillment.batch.create":
      return Object.freeze({
        operation: "batch_create" as const,
        input: Object.freeze({
          ...FactoryBatchCreateInputSchema.parse(parsed),
          ...base,
        }) satisfies FactoryCreateInput,
      });
    case "fulfillment.batch.cancel":
      return Object.freeze({
        operation: "batch_cancel" as const,
        input: Object.freeze({
          ...FactoryBatchCancelInputSchema.parse(parsed),
          ...base,
        }) satisfies FactoryCancelInput,
      });
    case "fulfillment.handoff.checkpoint.record":
      return Object.freeze({
        operation: "checkpoint_record" as const,
        input: Object.freeze({
          ...FactoryHandoffCheckpointRecordInputSchema.parse(parsed),
          ...base,
        }) satisfies FactoryCheckpointInput,
      });
    case "fulfillment.handoff.discrepancy.resolve":
      return Object.freeze({
        operation: "discrepancy_resolve" as const,
        input: Object.freeze({
          ...FactoryHandoffDiscrepancyResolveInputSchema.parse(parsed),
          ...base,
        }) satisfies FactoryResolveInput,
      });
    case "fulfillment.quality_check.record":
      return Object.freeze({
        operation: "quality_check" as const,
        input: Object.freeze({
          ...FactoryQualityCheckRecordInputSchema.parse(parsed),
          ...base,
        }) satisfies FactoryQualityInput,
      });
    default:
      return null;
  }
}

function fulfillmentRequest(
  parsed: unknown,
  context: Parameters<PendingActionPreparer>[1],
): FulfillmentConfirmationRequest | null {
  const base = Object.freeze({
    org_id: context.tenant.orgId,
    store_id: context.tenant.storeId,
  });
  switch (context.definition.name) {
    case "garment.bulk_transition": {
      const input = GarmentBulkTransitionInputSchema.parse(parsed);
      return Object.freeze({
        ...base,
        operation: "bulk_transition" as const,
        garment_ids: input.garment_ids,
        target_status: input.target_status,
        incident_kind: null,
        compensation_cents: null,
        reason: null,
        note: input.note ?? null,
      });
    }
    case "garment.rework": {
      const input = GarmentReworkInputSchema.parse(parsed);
      return Object.freeze({
        ...base,
        operation: "rework" as const,
        garment_ids: input.garment_ids,
        target_status: null,
        incident_kind: null,
        compensation_cents: null,
        reason: input.reason,
        note: null,
      });
    }
    case "garment.incident.record": {
      const input = GarmentIncidentRecordInputSchema.parse(parsed);
      return Object.freeze({
        ...base,
        operation: "incident_record" as const,
        garment_ids: Object.freeze([input.garment_id]),
        target_status: null,
        incident_kind: input.kind,
        compensation_cents: input.compensation_cents ?? 0,
        reason: null,
        note: input.note,
      });
    }
    case "garment.mark_lost": {
      const input = GarmentMarkLostInputSchema.parse(parsed);
      return Object.freeze({
        ...base,
        operation: "mark_lost" as const,
        garment_ids: Object.freeze([input.garment_id]),
        target_status: null,
        incident_kind: null,
        compensation_cents: input.compensation_cents,
        reason: input.reason,
        note: null,
      });
    }
    default:
      return null;
  }
}

export function createFulfillmentConfirmationPreparer(
  deps: FulfillmentRuntimeDeps,
): PendingActionPreparer {
  return async (parsed, context) => {
    if (context.definition.name.startsWith("fulfillment.")) {
      const request = await factoryRequest(deps, parsed, context);
      if (request === null) return null;
      const summary = await deps.store.prepareFactoryConfirmation(request);
      if (summary === null) {
        throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
      }
      const authority = FactoryHandoffConfirmationSummarySchema.parse(summary);
      return Object.freeze({ authority, summary: authority });
    }
    const request = fulfillmentRequest(parsed, context);
    if (request === null) return null;
    await prepareFulfillmentWrite(deps, context);
    const summary = await deps.store.prepareFulfillmentConfirmation(request);
    if (summary === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    const authority = FulfillmentOperationConfirmationSummarySchema.parse(summary);
    return Object.freeze({ authority, summary: authority });
  };
}
