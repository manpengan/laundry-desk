import {
  createCommandError,
  FulfillmentGarmentStatusSchema,
  FulfillmentOperationConfirmationSummarySchema,
} from "@laundry/contracts";
import type { GarmentStatus } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { FulfillmentIncidentKind } from "./types.js";
import type { OrderStore } from "../order/types.js";
import {
  assertFulfillmentEnabled,
  prepareFulfillmentWrite,
  type FulfillmentRuntimeDeps,
} from "./handler-support.js";
import {
  registerFactoryCommandHandlers,
  registerFactoryQueryHandlers,
} from "./factory-handlers.js";

export type FulfillmentHandlerDeps = FulfillmentRuntimeDeps &
  Readonly<{
    order?: Pick<OrderStore, "getOrder" | "lookupOrderSummaries">;
  }>;

const NORMAL_TARGETS = new Set<GarmentStatus>(["washing", "ready"]);

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return value;
}

function requireIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return Object.freeze([...value]);
}

function transitionHandler(
  deps: FulfillmentHandlerDeps,
  mode: "single" | "bulk" | "rework" | "lost",
): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const garmentIds =
      mode === "single" || mode === "lost"
        ? Object.freeze([requireString(input.garment_id)])
        : requireIds(input.garment_ids);
    const targetStatus: GarmentStatus =
      mode === "rework"
        ? "reworked"
        : mode === "lost"
          ? "lost"
          : FulfillmentGarmentStatusSchema.parse(input.target_status);
    if ((mode === "single" || mode === "bulk") && !NORMAL_TARGETS.has(targetStatus)) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const reason =
      mode === "rework" || mode === "lost"
        ? requireString(input.reason)
        : typeof input.note === "string" && input.note.length > 0
          ? input.note
          : null;
    const compensation =
      mode === "lost" && typeof input.compensation_cents === "number"
        ? input.compensation_cents
        : 0;
    const at = await prepareFulfillmentWrite(deps, ctx);
    let expectedManifestDigest: string | undefined;
    if (mode === "bulk" || mode === "rework" || mode === "lost") {
      if (ctx.request.confirmRef !== undefined) {
        const operation =
          mode === "bulk" ? "bulk_transition" : mode === "rework" ? "rework" : "mark_lost";
        const frozen = FulfillmentOperationConfirmationSummarySchema.safeParse(
          ctx.confirmationAuthority,
        );
        if (!frozen.success || frozen.data.operation !== operation) {
          throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
        }
        expectedManifestDigest = frozen.data.manifest_digest;
      }
    }
    const changes = await deps.store.transition({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      garment_ids: garmentIds,
      target_status: targetStatus,
      staff_id: ctx.actor.staffId,
      ...(mode === "lost" ? { device_id: ctx.actor.deviceId } : {}),
      at,
      reason,
      ...(mode === "bulk" ? { note: reason } : {}),
      ...(mode === "bulk" || mode === "rework" || mode === "lost"
        ? {
            confirmation_operation:
              mode === "bulk"
                ? ("bulk_transition" as const)
                : mode === "rework"
                  ? ("rework" as const)
                  : ("mark_lost" as const),
          }
        : {}),
      ...(expectedManifestDigest === undefined
        ? {}
        : { expected_manifest_digest: expectedManifestDigest }),
      ...(mode === "rework"
        ? {
            incident: Object.freeze({
              kind: "rework" as const,
              note: reason!,
              compensation_cents: 0,
            }),
          }
        : mode === "lost"
          ? {
              incident: Object.freeze({
                kind: "lost" as const,
                note: reason!,
                compensation_cents: compensation,
              }),
            }
          : {}),
    });
    if (changes === null) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    return Object.freeze({
      result: Object.freeze({
        transitioned_count: changes.length,
        garments: Object.freeze(changes.map((row) => Object.freeze({ ...row }))),
      }),
      audit: Object.freeze({
        entity: changes.length === 1 ? "garment" : "garment_batch",
        entityId: changes[0]?.garment_id ?? ctx.tenant.storeId,
        afterJson: JSON.stringify({
          garment_ids: changes.map((row) => row.garment_id),
          target_status: targetStatus,
          ...(reason === null ? {} : { reason }),
          ...(mode === "lost" ? { compensation_cents: compensation } : {}),
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type:
            mode === "rework"
              ? "garment.reworked"
              : mode === "lost"
                ? "garment.lost"
                : "garment.status_changed",
          payload: Object.freeze({
            garment_ids: Object.freeze(changes.map((row) => row.garment_id)),
            target_status: targetStatus,
          }),
        }),
      ]),
    });
  };
}

function incidentHandler(deps: FulfillmentHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    const garmentId = requireString(input.garment_id);
    const kind = requireString(input.kind) as FulfillmentIncidentKind;
    if (kind !== "damage" && kind !== "other") {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const note = requireString(input.note);
    const compensation =
      typeof input.compensation_cents === "number" ? input.compensation_cents : 0;
    const at = await prepareFulfillmentWrite(deps, ctx);
    let expectedManifestDigest: string | undefined;
    if (ctx.request.confirmRef !== undefined) {
      const frozen = FulfillmentOperationConfirmationSummarySchema.safeParse(
        ctx.confirmationAuthority,
      );
      if (!frozen.success || frozen.data.operation !== "incident_record") {
        throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
      }
      expectedManifestDigest = frozen.data.manifest_digest;
    }
    const result = await deps.store.recordIncident({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      garment_id: garmentId,
      kind,
      note,
      compensation_cents: compensation,
      staff_id: ctx.actor.staffId,
      at,
      ...(expectedManifestDigest === undefined
        ? {}
        : { expected_manifest_digest: expectedManifestDigest }),
    });
    if (result === null) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "garment_incident",
        entityId: result.incident_id,
        afterJson: JSON.stringify({
          garment_id: result.garment_id,
          kind: result.kind,
          compensation_cents: result.compensation_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "garment.incident_recorded",
          payload: Object.freeze({
            incident_id: result.incident_id,
            garment_id: result.garment_id,
            kind: result.kind,
          }),
        }),
      ]),
    });
  };
}

function rackAssignHandler(deps: FulfillmentHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const at = await prepareFulfillmentWrite(deps, ctx);
    const input = asRecord(ctx.parsed);
    const barcode = requireString(input.barcode).trim();
    if (deps.order?.lookupOrderSummaries !== undefined) {
      const matches = await deps.order.lookupOrderSummaries(ctx.tenant.orgId, ctx.tenant.storeId, {
        key: barcode,
        status: "open",
        limit: 2,
      });
      if (matches.length !== 1) {
        throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
      }
      const order = await deps.order.getOrder(
        ctx.tenant.orgId,
        ctx.tenant.storeId,
        matches[0]!.order_id,
      );
      if (order?.skip_rack_assignment === true) {
        throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
      }
    }
    const result = await deps.store.assignRack({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      barcode,
      rack_zone: requireString(input.rack_zone).trim().toUpperCase(),
      rack_slot: requireString(input.rack_slot).trim().toUpperCase(),
      staff_id: ctx.actor.staffId,
      at,
    });
    if (result === null) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "garment",
        entityId: result.garment_id,
        afterJson: JSON.stringify({
          status: result.status,
          rack_zone: result.rack_zone,
          rack_slot: result.rack_slot,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "garment.racked",
          payload: Object.freeze({
            garment_id: result.garment_id,
            rack_zone: result.rack_zone,
            rack_slot: result.rack_slot,
          }),
        }),
      ]),
    });
  };
}

function workbenchHandler(deps: FulfillmentHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    await assertFulfillmentEnabled(deps, ctx);
    const input = asRecord(ctx.parsed);
    const statuses = Array.isArray(input.statuses)
      ? Object.freeze(input.statuses.map((status) => FulfillmentGarmentStatusSchema.parse(status)))
      : undefined;
    const garments = await deps.store.listWorkbench(ctx.tenant.orgId, ctx.tenant.storeId, {
      ...(statuses === undefined ? {} : { statuses }),
      ...(typeof input.key === "string" ? { key: input.key } : {}),
      limit: typeof input.limit === "number" ? input.limit : 50,
    });
    return Object.freeze({
      result: Object.freeze({
        garments: Object.freeze(garments.map((row) => Object.freeze({ ...row }))),
      }),
    });
  };
}

export function registerFulfillmentCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: FulfillmentHandlerDeps,
): void {
  registry.registerHandler("garment.transition", transitionHandler(deps, "single"));
  registry.registerHandler("garment.bulk_transition", transitionHandler(deps, "bulk"));
  registry.registerHandler("garment.rack.assign", rackAssignHandler(deps));
  registry.registerHandler("garment.rework", transitionHandler(deps, "rework"));
  registry.registerHandler("garment.incident.record", incidentHandler(deps));
  registry.registerHandler("garment.mark_lost", transitionHandler(deps, "lost"));
  registerFactoryCommandHandlers(registry, deps);
}

export function registerFulfillmentQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: FulfillmentHandlerDeps,
): void {
  registry.registerHandler("fulfillment.workbench", workbenchHandler(deps));
  registerFactoryQueryHandlers(registry, deps);
}
