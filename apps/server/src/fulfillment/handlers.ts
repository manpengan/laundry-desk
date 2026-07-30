import { createCommandError, FulfillmentGarmentStatusSchema } from "@laundry/contracts";
import type { GarmentStatus } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { FulfillmentIncidentKind, FulfillmentStore } from "./types.js";

export type FulfillmentHandlerDeps = Readonly<{
  store: FulfillmentStore;
  now?: () => number;
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
    const at = deps.now?.() ?? Math.floor(Date.now() / 1000);
    const changes = await deps.store.transition({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      garment_ids: garmentIds,
      target_status: targetStatus,
      staff_id: ctx.actor.staffId,
      at,
      reason,
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
    const result = await deps.store.recordIncident({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      garment_id: garmentId,
      kind,
      note,
      compensation_cents: compensation,
      staff_id: ctx.actor.staffId,
      at: deps.now?.() ?? Math.floor(Date.now() / 1000),
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
    const input = asRecord(ctx.parsed);
    const result = await deps.store.assignRack({
      org_id: ctx.tenant.orgId,
      store_id: ctx.tenant.storeId,
      barcode: requireString(input.barcode).trim(),
      rack_zone: requireString(input.rack_zone).trim().toUpperCase(),
      rack_slot: requireString(input.rack_slot).trim().toUpperCase(),
      staff_id: ctx.actor.staffId,
      at: deps.now?.() ?? Math.floor(Date.now() / 1000),
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
}

export function registerFulfillmentQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: FulfillmentHandlerDeps,
): void {
  registry.registerHandler("fulfillment.workbench", workbenchHandler(deps));
}
