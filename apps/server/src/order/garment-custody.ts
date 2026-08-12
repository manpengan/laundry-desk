import type { GarmentRecord } from "./types.js";

export function isGarmentAvailableAtStore(garment: GarmentRecord): boolean {
  return (
    (garment.custody_state ?? "store") === "store" &&
    (garment.active_production_batch_id ?? null) === null
  );
}
