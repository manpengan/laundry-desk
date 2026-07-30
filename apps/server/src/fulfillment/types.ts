import type { GarmentStatus } from "@laundry/domain";

export type FulfillmentIncidentKind = "rework" | "damage" | "lost" | "other";

export type FulfillmentTransitionInput = Readonly<{
  org_id: string;
  store_id: string;
  garment_ids: readonly string[];
  target_status: GarmentStatus;
  staff_id: string;
  at: number;
  reason: string | null;
  incident?: Readonly<{
    kind: FulfillmentIncidentKind;
    note: string;
    compensation_cents: number;
  }>;
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
  updated_at: number;
  incident_count: number;
}>;

export type FulfillmentStore = Readonly<{
  transition: (
    input: FulfillmentTransitionInput,
  ) => Promise<readonly FulfillmentTransitionRow[] | null>;
  recordIncident: (input: FulfillmentIncidentInput) => Promise<FulfillmentIncidentResult | null>;
  listWorkbench: (
    orgId: string,
    storeId: string,
    options: FulfillmentWorkbenchOptions,
  ) => Promise<readonly FulfillmentWorkbenchRow[]>;
}>;
