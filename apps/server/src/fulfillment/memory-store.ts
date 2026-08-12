import { canTransition } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import { createMemoryFactoryHandoffStore } from "./factory-memory-store.js";
import {
  createMemoryFulfillmentState,
  type MemoryFulfillmentSnapshot,
} from "./factory-memory-state.js";
import { fulfillmentConfirmationSummary } from "./factory-manifest.js";
import { publicMemoryWorkbenchRow } from "./memory-workbench-row.js";
import type {
  FulfillmentIncidentResult,
  FulfillmentStore,
  FulfillmentTransitionRow,
  FulfillmentWorkbenchRow,
} from "./types.js";

export type MemoryFulfillmentSeed = Readonly<{
  garments?: readonly FulfillmentWorkbenchRow[];
}>;

function replaceGarments(
  current: MemoryFulfillmentSnapshot,
  garments: MemoryFulfillmentSnapshot["garments"],
): MemoryFulfillmentSnapshot {
  return Object.freeze({ ...current, garments: Object.freeze(garments) });
}

export function createMemoryFulfillmentStore(
  seed: MemoryFulfillmentSeed = {},
  newId: () => string = randomUUID,
): FulfillmentStore {
  const state = createMemoryFulfillmentState(seed.garments ?? []);
  const factory = createMemoryFactoryHandoffStore(state, newId);

  return Object.freeze({
    ...factory,
    async prepareFulfillmentConfirmation(request) {
      const snapshot = state.read();
      const unique = new Set(request.garment_ids);
      const rows = snapshot.garments.filter(
        (row) =>
          row.org_id === request.org_id &&
          row.store_id === request.store_id &&
          unique.has(row.garment_id),
      );
      if (
        unique.size !== request.garment_ids.length ||
        rows.length !== unique.size ||
        rows.some((row) => {
          if (row.order_status !== "open" || row.customer_pii_purged_at !== null) return true;
          if (
            request.operation !== "mark_lost" &&
            (row.custody_state !== "store" || row.active_production_batch_id !== null)
          ) {
            return true;
          }
          if (
            request.operation === "mark_lost" &&
            row.active_production_batch_id !== null &&
            (row.custody_state !== "exception" ||
              !snapshot.members.some(
                (member) =>
                  member.batch_id === row.active_production_batch_id &&
                  member.garment_id === row.garment_id &&
                  member.member_state === "exception",
              ))
          ) {
            return true;
          }
          if (request.operation === "incident_record") {
            return ["picked_up", "delivered", "lost"].includes(row.status);
          }
          const target =
            request.operation === "bulk_transition"
              ? request.target_status
              : request.operation === "rework"
                ? "reworked"
                : "lost";
          return target === null || !canTransition(row.status, target);
        })
      ) {
        return null;
      }
      return fulfillmentConfirmationSummary(request, rows);
    },

    async transition(input) {
      return state.mutate((current) => {
        const uniqueIds = new Set(input.garment_ids);
        const selected = current.garments.filter(
          (row) =>
            row.org_id === input.org_id &&
            row.store_id === input.store_id &&
            uniqueIds.has(row.garment_id),
        );
        const operation =
          input.confirmation_operation ??
          (input.target_status === "lost"
            ? "mark_lost"
            : input.target_status === "reworked"
              ? "rework"
              : "bulk_transition");
        const authority = fulfillmentConfirmationSummary(
          {
            operation,
            org_id: input.org_id,
            store_id: input.store_id,
            garment_ids: input.garment_ids,
            target_status:
              input.target_status === "washing" || input.target_status === "ready"
                ? input.target_status
                : null,
            incident_kind: null,
            compensation_cents:
              operation === "mark_lost" ? (input.incident?.compensation_cents ?? null) : null,
            reason: operation === "bulk_transition" ? null : input.reason,
            note: operation === "bulk_transition" ? (input.note ?? null) : null,
          },
          selected,
        );
        if (
          uniqueIds.size !== input.garment_ids.length ||
          selected.length !== input.garment_ids.length ||
          (input.expected_manifest_digest !== undefined &&
            authority.manifest_digest !== input.expected_manifest_digest) ||
          (input.target_status === "lost" &&
            input.device_id == null &&
            selected.some((row) => row.active_production_batch_id !== null)) ||
          selected.some(
            (row) =>
              row.order_status !== "open" ||
              row.customer_pii_purged_at !== null ||
              !canTransition(row.status, input.target_status) ||
              (input.target_status === "lost" &&
                row.active_production_batch_id !== null &&
                (row.custody_state !== "exception" ||
                  !current.members.some(
                    (member) =>
                      member.batch_id === row.active_production_batch_id &&
                      member.garment_id === row.garment_id &&
                      member.member_state === "exception",
                  ))) ||
              (input.target_status !== "lost" &&
                (row.custody_state !== "store" || row.active_production_batch_id !== null)),
          )
        ) {
          return [current, null] as const;
        }
        const changes: FulfillmentTransitionRow[] = selected.map((row) =>
          Object.freeze({
            garment_id: row.garment_id,
            order_id: row.order_id,
            from_status: row.status,
            to_status: input.target_status,
          }),
        );
        const selectedIds = new Set(selected.map((row) => row.garment_id));
        const nextGarments = current.garments.map((row) =>
          row.org_id === input.org_id &&
          row.store_id === input.store_id &&
          selectedIds.has(row.garment_id)
            ? Object.freeze({
                ...row,
                status: input.target_status,
                rack_zone: null,
                rack_slot: null,
                updated_at: input.at,
                ...(input.target_status === "lost"
                  ? { custody_state: "exception" as const, active_production_batch_id: null }
                  : {}),
              })
            : row,
        );
        const appended: readonly FulfillmentIncidentResult[] =
          input.incident === undefined
            ? Object.freeze([])
            : Object.freeze(
                selected.map((row) =>
                  Object.freeze({
                    incident_id: newId(),
                    garment_id: row.garment_id,
                    order_id: row.order_id,
                    kind: input.incident!.kind,
                    compensation_cents: input.incident!.compensation_cents,
                    created_at: input.at,
                  }),
                ),
              );
        const lostBatchIds = new Set(
          selected
            .map((row) => row.active_production_batch_id)
            .filter((id): id is string => id !== null),
        );
        const nextMembers = current.members.map((member) =>
          input.target_status === "lost" &&
          selectedIds.has(member.garment_id) &&
          lostBatchIds.has(member.batch_id) &&
          member.member_state === "exception"
            ? Object.freeze({ ...member, member_state: "exception" as const })
            : member,
        );
        const nextBatches = current.batches.map((batch) =>
          lostBatchIds.has(batch.batch_id) &&
          batch.status !== "store_received" &&
          batch.status !== "cancelled"
            ? Object.freeze({
                ...batch,
                exception_count: nextMembers.filter(
                  (member) =>
                    member.batch_id === batch.batch_id && member.member_state === "exception",
                ).length,
                version: batch.version + 1,
                updated_at: input.at,
              })
            : batch,
        );
        return [
          Object.freeze({
            ...replaceGarments(current, nextGarments),
            incidents: Object.freeze([...current.incidents, ...appended]),
            members: Object.freeze(nextMembers),
            batches: Object.freeze(nextBatches),
          }),
          Object.freeze(changes),
        ] as const;
      });
    },

    async assignRack(input) {
      return state.mutate((current) => {
        const index = current.garments.findIndex(
          (row) =>
            row.org_id === input.org_id &&
            row.store_id === input.store_id &&
            row.barcode.toUpperCase() === input.barcode.toUpperCase(),
        );
        const garment = current.garments[index];
        if (
          garment === undefined ||
          garment.order_status !== "open" ||
          garment.customer_pii_purged_at !== null ||
          garment.custody_state !== "store" ||
          garment.active_production_batch_id !== null
        ) {
          return [current, null] as const;
        }
        if (
          garment.status === "racked" &&
          garment.rack_zone === input.rack_zone &&
          garment.rack_slot === input.rack_slot
        ) {
          return [
            current,
            Object.freeze({
              garment_id: garment.garment_id,
              order_id: garment.order_id,
              barcode: garment.barcode,
              rack_zone: input.rack_zone,
              rack_slot: input.rack_slot,
              status: "racked" as const,
              racked_at: garment.updated_at,
            }),
          ] as const;
        }
        if (garment.status !== "ready") return [current, null] as const;
        const next = Object.freeze({
          ...garment,
          status: "racked" as const,
          rack_zone: input.rack_zone,
          rack_slot: input.rack_slot,
          updated_at: input.at,
        });
        const garments = current.garments.map((row, rowIndex) => (rowIndex === index ? next : row));
        return [
          replaceGarments(current, garments),
          Object.freeze({
            garment_id: garment.garment_id,
            order_id: garment.order_id,
            barcode: garment.barcode,
            rack_zone: input.rack_zone,
            rack_slot: input.rack_slot,
            status: "racked" as const,
            racked_at: input.at,
          }),
        ] as const;
      });
    },

    async recordIncident(input) {
      return state.mutate((current) => {
        const garment = current.garments.find(
          (row) =>
            row.org_id === input.org_id &&
            row.store_id === input.store_id &&
            row.garment_id === input.garment_id,
        );
        const authority =
          garment === undefined
            ? null
            : fulfillmentConfirmationSummary(
                {
                  operation: "incident_record",
                  org_id: input.org_id,
                  store_id: input.store_id,
                  garment_ids: [input.garment_id],
                  target_status: null,
                  incident_kind: input.kind,
                  compensation_cents: input.compensation_cents,
                  reason: null,
                  note: input.note,
                },
                [garment],
              );
        if (
          garment === undefined ||
          garment.order_status !== "open" ||
          garment.customer_pii_purged_at !== null ||
          garment.custody_state !== "store" ||
          garment.active_production_batch_id !== null ||
          garment.status === "picked_up" ||
          garment.status === "delivered" ||
          garment.status === "lost" ||
          (input.expected_manifest_digest !== undefined &&
            authority?.manifest_digest !== input.expected_manifest_digest)
        ) {
          return [current, null] as const;
        }
        const incident = Object.freeze({
          incident_id: newId(),
          garment_id: garment.garment_id,
          order_id: garment.order_id,
          kind: input.kind,
          compensation_cents: input.compensation_cents,
          created_at: input.at,
        });
        return [
          Object.freeze({
            ...current,
            incidents: Object.freeze([...current.incidents, incident]),
          }),
          incident,
        ] as const;
      });
    },

    async listWorkbench(orgId, storeId, options) {
      const snapshot = state.read();
      const statuses = options.statuses === undefined ? null : new Set(options.statuses);
      const key = options.key?.trim().toLowerCase() ?? "";
      const rows = snapshot.garments
        .filter((row) => row.org_id === orgId && row.store_id === storeId)
        .filter((row) => statuses === null || statuses.has(row.status))
        .filter(
          (row) =>
            key.length === 0 ||
            row.ticket_no.toLowerCase().includes(key) ||
            row.barcode.toLowerCase().includes(key) ||
            row.customer_name?.toLowerCase().includes(key) === true ||
            row.customer_phone_masked?.includes(key) === true ||
            row.rack_zone?.toLowerCase().includes(key) === true ||
            row.rack_slot?.toLowerCase().includes(key) === true ||
            `${row.rack_zone ?? ""}-${row.rack_slot ?? ""}`.toLowerCase().includes(key),
        )
        .sort((left, right) => right.updated_at - left.updated_at)
        .slice(0, options.limit)
        .map((row) =>
          publicMemoryWorkbenchRow(
            Object.freeze({
              ...row,
              incident_count: snapshot.incidents.filter(
                (item) => item.garment_id === row.garment_id,
              ).length,
            }),
          ),
        );
      return Object.freeze(rows);
    },
  });
}
