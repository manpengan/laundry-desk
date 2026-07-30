import { canTransition } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type {
  FulfillmentIncidentResult,
  FulfillmentStore,
  FulfillmentTransitionRow,
  FulfillmentWorkbenchRow,
} from "./types.js";

export type MemoryFulfillmentSeed = Readonly<{
  garments?: readonly FulfillmentWorkbenchRow[];
}>;

const maskPhone = (phone: string | null): string | null =>
  phone === null || phone.includes("*") ? phone : `${phone.slice(0, 3)}****${phone.slice(-4)}`;

export function createMemoryFulfillmentStore(
  seed: MemoryFulfillmentSeed = {},
  newId: () => string = randomUUID,
): FulfillmentStore {
  const garments = (seed.garments ?? []).map((row) => Object.freeze({ ...row }));
  const incidents: FulfillmentIncidentResult[] = [];

  return Object.freeze({
    async transition(input) {
      const uniqueIds = new Set(input.garment_ids);
      if (uniqueIds.size !== input.garment_ids.length) return null;
      const selected = garments.filter((row) => uniqueIds.has(row.garment_id));
      if (
        selected.length !== input.garment_ids.length ||
        selected.some((row) => !canTransition(row.status, input.target_status))
      ) {
        return null;
      }
      const changes: FulfillmentTransitionRow[] = [];
      for (const row of selected) {
        const index = garments.findIndex((candidate) => candidate.garment_id === row.garment_id);
        const next = Object.freeze({
          ...row,
          status: input.target_status,
          rack_zone: null,
          rack_slot: null,
          updated_at: input.at,
        });
        garments[index] = next;
        changes.push(
          Object.freeze({
            garment_id: row.garment_id,
            order_id: row.order_id,
            from_status: row.status,
            to_status: input.target_status,
          }),
        );
        if (input.incident !== undefined) {
          incidents.push(
            Object.freeze({
              incident_id: newId(),
              garment_id: row.garment_id,
              order_id: row.order_id,
              kind: input.incident.kind,
              compensation_cents: input.incident.compensation_cents,
              created_at: input.at,
            }),
          );
        }
      }
      return Object.freeze(changes);
    },

    async assignRack(input) {
      const index = garments.findIndex(
        (row) => row.barcode.toUpperCase() === input.barcode.toUpperCase(),
      );
      const garment = garments[index];
      if (garment === undefined) return null;
      if (
        garment.status === "racked" &&
        garment.rack_zone === input.rack_zone &&
        garment.rack_slot === input.rack_slot
      ) {
        return Object.freeze({
          garment_id: garment.garment_id,
          order_id: garment.order_id,
          barcode: garment.barcode,
          rack_zone: input.rack_zone,
          rack_slot: input.rack_slot,
          status: "racked",
          racked_at: garment.updated_at,
        });
      }
      if (garment.status !== "ready") return null;
      garments[index] = Object.freeze({
        ...garment,
        status: "racked",
        rack_zone: input.rack_zone,
        rack_slot: input.rack_slot,
        updated_at: input.at,
      });
      return Object.freeze({
        garment_id: garment.garment_id,
        order_id: garment.order_id,
        barcode: garment.barcode,
        rack_zone: input.rack_zone,
        rack_slot: input.rack_slot,
        status: "racked",
        racked_at: input.at,
      });
    },

    async recordIncident(input) {
      const garment = garments.find((row) => row.garment_id === input.garment_id);
      if (
        garment === undefined ||
        garment.status === "picked_up" ||
        garment.status === "delivered" ||
        garment.status === "lost"
      ) {
        return null;
      }
      const incident = Object.freeze({
        incident_id: newId(),
        garment_id: garment.garment_id,
        order_id: garment.order_id,
        kind: input.kind,
        compensation_cents: input.compensation_cents,
        created_at: input.at,
      });
      incidents.push(incident);
      return incident;
    },

    async listWorkbench(_orgId, _storeId, options) {
      const statuses = options.statuses === undefined ? null : new Set(options.statuses);
      const key = options.key?.trim().toLowerCase() ?? "";
      const rows = garments
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
          Object.freeze({
            ...row,
            customer_phone_masked: maskPhone(row.customer_phone_masked),
            incident_count: incidents.filter((item) => item.garment_id === row.garment_id).length,
          }),
        );
      return Object.freeze(rows);
    },
  });
}
