import type { MemoryFulfillmentSnapshot } from "./factory-memory-state.js";

const maskPhone = (phone: string | null): string | null =>
  phone === null || phone.includes("*") ? phone : `${phone.slice(0, 3)}****${phone.slice(-4)}`;

export function publicMemoryWorkbenchRow(row: MemoryFulfillmentSnapshot["garments"][number]) {
  return Object.freeze({
    garment_id: row.garment_id,
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    barcode: row.barcode,
    customer_name: row.customer_name,
    customer_phone_masked: maskPhone(row.customer_phone_masked),
    service_code: row.service_code,
    category_code: row.category_code,
    color: row.color,
    brand: row.brand,
    status: row.status,
    rack_zone: row.rack_zone,
    rack_slot: row.rack_slot,
    updated_at: row.updated_at,
    incident_count: row.incident_count,
  });
}
