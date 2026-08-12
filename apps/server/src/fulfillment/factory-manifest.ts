import { createHash } from "node:crypto";

import type {
  FulfillmentConfirmationRequest,
  FulfillmentOperationConfirmationSummary,
} from "./types.js";

export type ManifestIdentity = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
}>;

export type FulfillmentAuthorityRow = ManifestIdentity &
  Readonly<{
    status: string;
    custody_state: string;
    active_production_batch_id: string | null;
  }>;

const compareIds = (left: ManifestIdentity, right: ManifestIdentity): number =>
  left.garment_id.localeCompare(right.garment_id);

export function sortedManifest<T extends ManifestIdentity>(rows: readonly T[]): readonly T[] {
  return Object.freeze([...rows].sort(compareIds));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function factoryManifestDigest(rows: readonly ManifestIdentity[]): string {
  return sha256Canonical(
    sortedManifest(rows).map((row) => ({
      garment_id: row.garment_id,
      order_id: row.order_id,
      ticket_no: row.ticket_no,
      barcode: row.barcode,
    })),
  );
}

export function fulfillmentConfirmationSummary(
  request: FulfillmentConfirmationRequest,
  rows: readonly FulfillmentAuthorityRow[],
): FulfillmentOperationConfirmationSummary {
  const sorted = sortedManifest(rows);
  return Object.freeze({
    kind: "fulfillment_operation" as const,
    operation: request.operation,
    garment_ids: Object.freeze(sorted.map((row) => row.garment_id)),
    ticket_nos: Object.freeze(sorted.map((row) => row.ticket_no).sort()),
    barcodes: Object.freeze(sorted.map((row) => row.barcode).sort()),
    target_status:
      request.target_status === "washing" || request.target_status === "ready"
        ? request.target_status
        : null,
    incident_kind: request.incident_kind,
    compensation_cents: request.compensation_cents,
    reason: request.reason,
    note: request.note,
    manifest_digest: sha256Canonical({
      operation: request.operation,
      target_status: request.target_status,
      incident_kind: request.incident_kind,
      compensation_cents: request.compensation_cents,
      reason: request.reason,
      note: request.note,
      garments: sorted.map((row) => ({
        garment_id: row.garment_id,
        order_id: row.order_id,
        ticket_no: row.ticket_no,
        barcode: row.barcode,
        status: row.status,
        custody_state: row.custody_state,
        active_production_batch_id: row.active_production_batch_id,
      })),
    }),
  });
}
