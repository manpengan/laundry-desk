import type { GarmentStatus } from "@laundry/domain";

import type { FactoryCustodyState, FactoryHandoffStore } from "./factory-types.js";

export type FulfillmentIncidentKind = "rework" | "damage" | "lost" | "other";

export type FulfillmentTransitionInput = Readonly<{
  org_id: string;
  store_id: string;
  garment_ids: readonly string[];
  target_status: GarmentStatus;
  staff_id: string;
  device_id?: string | null;
  at: number;
  reason: string | null;
  note?: string | null;
  confirmation_operation?: Exclude<FulfillmentConfirmationOperation, "incident_record">;
  expected_manifest_digest?: string;
  incident?: Readonly<{
    kind: FulfillmentIncidentKind;
    note: string;
    compensation_cents: number;
  }>;
}>;

export type FulfillmentRackAssignInput = Readonly<{
  org_id: string;
  store_id: string;
  barcode: string;
  rack_zone: string;
  rack_slot: string;
  staff_id: string;
  at: number;
}>;

export type FulfillmentRackAssignResult = Readonly<{
  garment_id: string;
  order_id: string;
  barcode: string;
  rack_zone: string;
  rack_slot: string;
  status: "racked";
  racked_at: number;
}>;

export type FulfillmentTransitionRow = Readonly<{
  garment_id: string;
  order_id: string;
  from_status: GarmentStatus;
  to_status: GarmentStatus;
}>;

export type FulfillmentIncidentInput = Readonly<{
  org_id: string;
  store_id: string;
  garment_id: string;
  kind: Exclude<FulfillmentIncidentKind, "rework" | "lost">;
  note: string;
  compensation_cents: number;
  staff_id: string;
  at: number;
  expected_manifest_digest?: string;
}>;

export type FulfillmentIncidentResult = Readonly<{
  incident_id: string;
  garment_id: string;
  order_id: string;
  kind: FulfillmentIncidentKind;
  compensation_cents: number;
  created_at: number;
}>;

export type FulfillmentWorkbenchOptions = Readonly<{
  statuses?: readonly GarmentStatus[];
  key?: string;
  limit: number;
}>;

export type FulfillmentWorkbenchRow = Readonly<{
  /** Server-only tenant authority; memory seeds without it remain inaccessible. */
  org_id?: string;
  /** Server-only tenant authority; memory seeds without it remain inaccessible. */
  store_id?: string;
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  customer_name: string | null;
  customer_phone_masked: string | null;
  service_code: string;
  category_code: string;
  color: string | null;
  brand: string | null;
  status: GarmentStatus;
  rack_zone: string | null;
  rack_slot: string | null;
  updated_at: number;
  incident_count: number;
  /** Server-only custody authority; omitted by older seeds and normalized to store. */
  custody_state?: FactoryCustodyState;
  /** Server-only active production batch anchor; never projected by workbench handlers. */
  active_production_batch_id?: string | null;
  /** Test-only mirror of the PostgreSQL privacy tombstone used for fail-closed parity. */
  customer_pii_purged_at?: number | null;
  /** Server-only order lifecycle authority; memory seeds default to open. */
  order_status?: "open" | "closed";
}>;

export type FulfillmentConfirmationOperation =
  "bulk_transition" | "rework" | "incident_record" | "mark_lost";

export type FulfillmentConfirmationRequest = Readonly<{
  operation: FulfillmentConfirmationOperation;
  org_id: string;
  store_id: string;
  garment_ids: readonly string[];
  target_status: GarmentStatus | null;
  incident_kind: "damage" | "other" | null;
  compensation_cents: number | null;
  reason: string | null;
  note: string | null;
}>;

export type FulfillmentOperationConfirmationSummary = Readonly<{
  kind: "fulfillment_operation";
  operation: FulfillmentConfirmationOperation;
  garment_ids: readonly string[];
  ticket_nos: readonly string[];
  barcodes: readonly string[];
  target_status: "washing" | "ready" | null;
  incident_kind: "damage" | "other" | null;
  compensation_cents: number | null;
  reason: string | null;
  note: string | null;
  manifest_digest: string;
}>;

export type FulfillmentStore = FactoryHandoffStore &
  Readonly<{
    prepareFulfillmentConfirmation: (
      request: FulfillmentConfirmationRequest,
    ) => Promise<FulfillmentOperationConfirmationSummary | null>;
    transition: (
      input: FulfillmentTransitionInput,
    ) => Promise<readonly FulfillmentTransitionRow[] | null>;
    assignRack: (input: FulfillmentRackAssignInput) => Promise<FulfillmentRackAssignResult | null>;
    recordIncident: (input: FulfillmentIncidentInput) => Promise<FulfillmentIncidentResult | null>;
    listWorkbench: (
      orgId: string,
      storeId: string,
      options: FulfillmentWorkbenchOptions,
    ) => Promise<readonly FulfillmentWorkbenchRow[]>;
  }>;
