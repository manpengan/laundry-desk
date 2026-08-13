import type { ConfirmationSummary } from "./responses.js";

const freezeRecords = <T extends object>(records: readonly T[]) =>
  Object.freeze(records.map((record) => Object.freeze({ ...record })));

export function freezeConfirmationSummary(summary: ConfirmationSummary): ConfirmationSummary {
  if (summary.kind === "notification_delivery_batch") {
    return Object.freeze({
      ...summary,
      ticket_nos: Object.freeze([...summary.ticket_nos]),
      garment_statuses: Object.freeze([...summary.garment_statuses]),
    });
  }
  if (summary.kind === "member_topup") {
    return Object.freeze({
      ...summary,
      matched_rule:
        summary.matched_rule === null ? null : Object.freeze({ ...summary.matched_rule }),
    });
  }
  if (summary.kind === "delivery_policy") {
    return Object.freeze({
      ...summary,
      service_areas: freezeRecords(summary.service_areas),
      weekly_windows: freezeRecords(summary.weekly_windows),
    });
  }
  if (summary.kind === "factory_handoff") {
    return Object.freeze({
      ...summary,
      ticket_nos: Object.freeze([...summary.ticket_nos]),
      barcodes: Object.freeze([...summary.barcodes]),
      counts: Object.freeze({ ...summary.counts }),
    });
  }
  if (summary.kind === "fulfillment_operation") {
    return Object.freeze({
      ...summary,
      garment_ids: Object.freeze([...summary.garment_ids]),
      ticket_nos: Object.freeze([...summary.ticket_nos]),
      barcodes: Object.freeze([...summary.barcodes]),
    });
  }
  return Object.freeze({ ...summary });
}
