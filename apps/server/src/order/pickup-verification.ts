import { createCommandError } from "@laundry/contracts";

import { HandlerCommandError } from "../bus/types.js";
import type { GarmentRecord } from "./types.js";

function validationError(): HandlerCommandError {
  return new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
}

export function parseVerificationBarcodes(value: unknown): readonly string[] {
  const raw = value ?? [];
  if (!Array.isArray(raw)) throw validationError();
  const barcodes = raw.map((barcode) => {
    if (typeof barcode !== "string" || barcode.length === 0) throw validationError();
    return barcode.trim().toUpperCase();
  });
  if (new Set(barcodes).size !== barcodes.length) throw validationError();
  return barcodes;
}

export function requireVerifiedRackBarcodes(
  garments: readonly GarmentRecord[],
  selectedGarmentIds: readonly string[],
  verificationBarcodes: readonly string[],
): readonly string[] {
  const selectedSet = new Set(selectedGarmentIds);
  const requiredBarcodes = garments
    .filter((garment) => selectedSet.has(garment.garment_id) && garment.status === "racked")
    .map((garment) => garment.barcode.toUpperCase());
  const verifiedSet = new Set(verificationBarcodes);
  if (
    requiredBarcodes.length !== verifiedSet.size ||
    requiredBarcodes.some((barcode) => !verifiedSet.has(barcode))
  ) {
    throw validationError();
  }
  return requiredBarcodes;
}
