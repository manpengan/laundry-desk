import {
  FactoryHandoffBatchGetResultSchema,
  FactoryHandoffBatchesListResultSchema,
  type FactoryBatchStatus,
  type FactoryHandoffBatchGetResult,
  type FactoryHandoffBatchesListResult,
  type FactoryHandoffCheckpoint,
} from "@laundry/contracts";

import { unwrapQueryResult } from "./customer-model.js";

export const FACTORY_BATCH_STATUS_LABELS: Readonly<Record<FactoryBatchStatus, string>> =
  Object.freeze({
    packing: "待出店",
    store_dispatched: "运往工厂",
    factory_received: "工厂已收",
    factory_dispatched: "运回门店",
    store_received: "门店已收",
    cancelled: "已取消",
  });

export const FACTORY_CHECKPOINT_LABELS: Readonly<Record<FactoryHandoffCheckpoint, string>> =
  Object.freeze({
    store_dispatch: "门店发出",
    factory_receive: "工厂收件",
    factory_dispatch: "工厂发回",
    store_receive: "门店收件",
  });

const NEXT_CHECKPOINT: Readonly<Partial<Record<FactoryBatchStatus, FactoryHandoffCheckpoint>>> =
  Object.freeze({
    packing: "store_dispatch",
    store_dispatched: "factory_receive",
    factory_received: "factory_dispatch",
    factory_dispatched: "store_receive",
  });

export function nextFactoryCheckpoint(status: FactoryBatchStatus): FactoryHandoffCheckpoint | null {
  return NEXT_CHECKPOINT[status] ?? null;
}

export function parseFactoryBatchList(value: unknown): FactoryHandoffBatchesListResult | null {
  const parsed = FactoryHandoffBatchesListResultSchema.safeParse(unwrapQueryResult(value));
  if (!parsed.success) return null;
  return Object.freeze({
    batches: parsed.data.batches.map((batch) => Object.freeze({ ...batch })),
    eligible_garments: parsed.data.eligible_garments.map((garment) =>
      Object.freeze({ ...garment }),
    ),
  });
}

export function parseFactoryBatchDetail(value: unknown): FactoryHandoffBatchGetResult | null {
  const parsed = FactoryHandoffBatchGetResultSchema.safeParse(unwrapQueryResult(value));
  if (!parsed.success) return null;
  return Object.freeze({
    batch: Object.freeze({ ...parsed.data.batch }),
    manifest: parsed.data.manifest.map((garment) => Object.freeze({ ...garment })),
    checkpoints: parsed.data.checkpoints.map((checkpoint) => Object.freeze({ ...checkpoint })),
    latest_attempt:
      parsed.data.latest_attempt === null
        ? null
        : Object.freeze({
            ...parsed.data.latest_attempt,
            matched_barcodes: [...parsed.data.latest_attempt.matched_barcodes],
            missing_barcodes: [...parsed.data.latest_attempt.missing_barcodes],
            unexpected_barcodes: [...parsed.data.latest_attempt.unexpected_barcodes],
          }),
    quality_checks: parsed.data.quality_checks.map((check) => Object.freeze({ ...check })),
  });
}

export function appendUniqueBarcode(
  current: readonly string[],
  rawBarcode: string,
): readonly string[] {
  const barcode = rawBarcode.trim();
  if (barcode.length === 0 || current.includes(barcode)) return current;
  return Object.freeze([...current, barcode]);
}
