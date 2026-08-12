import type { GarmentStatus } from "@laundry/domain";

import { factoryManifestDigest } from "./factory-manifest.js";
import type { MemoryFulfillmentState } from "./factory-memory-state.js";
import {
  batchListRow,
  expectedCheckpoint,
  factoryMutation,
  garmentFor,
  hasUnresolvedFactoryDiscrepancy,
  manifestFor,
  membersFor,
  sameStringSet,
  scopedBatch,
} from "./factory-memory-support.js";
import type { FactoryHandoffStore } from "./factory-types.js";

type QualityReadMethods = Pick<
  FactoryHandoffStore,
  "recordFactoryQuality" | "listFactoryBatches" | "getFactoryBatch"
>;

export function createMemoryFactoryQualityReadMethods(
  state: MemoryFulfillmentState,
  newId: () => string,
): QualityReadMethods {
  return Object.freeze({
    async recordFactoryQuality(input) {
      return state.mutate((current) => {
        const batch = scopedBatch(current, input.org_id, input.store_id, input.batch_id);
        const active = membersFor(current, input.batch_id, true);
        const checkIds = input.checks.map((check) => check.garment_id);
        if (
          batch === null ||
          batch.status !== "factory_received" ||
          batch.version !== input.expected_version ||
          hasUnresolvedFactoryDiscrepancy(
            current,
            batch.batch_id,
            batch.version,
            "factory_dispatch",
          ) ||
          input.device_id === null ||
          !sameStringSet(input.garment_ids, checkIds) ||
          checkIds.some((id) => !active.some((member) => member.garment_id === id)) ||
          input.checks.some((check) => {
            const garment = garmentFor(current, check.garment_id, input.org_id, input.store_id);
            return (
              garment === null ||
              garment.customer_pii_purged_at !== null ||
              garment.custody_state !== "factory" ||
              !["washing", "reworked", "ready"].includes(garment.status)
            );
          })
        ) {
          return [current, null] as const;
        }
        const manifestDigest = factoryManifestDigest(manifestFor(current, batch.batch_id));
        if (
          input.expected_manifest_digest !== undefined &&
          input.expected_manifest_digest !== manifestDigest
        ) {
          return [current, null] as const;
        }
        const byId = new Map(input.checks.map((check) => [check.garment_id, check]));
        const garments = current.garments.map((garment) => {
          if (garment.org_id !== batch.org_id || garment.store_id !== batch.store_id)
            return garment;
          const check = byId.get(garment.garment_id);
          return check === undefined
            ? garment
            : Object.freeze({
                ...garment,
                status: (check.outcome === "pass" ? "ready" : "reworked") as GarmentStatus,
                rack_zone: null,
                rack_slot: null,
                updated_at: input.at,
              });
        });
        const members = current.members.map((member) => {
          const check =
            member.batch_id === batch.batch_id ? byId.get(member.garment_id) : undefined;
          return check === undefined
            ? member
            : Object.freeze({ ...member, qc_status: check.outcome });
        });
        const qualities = input.checks.map((check) =>
          Object.freeze({
            batch_id: batch.batch_id,
            garment_id: check.garment_id,
            outcome: check.outcome,
            reason_code: check.reason_code,
            inspected_at: input.at,
          }),
        );
        const incidents = input.checks.flatMap((check) => {
          const garment = garmentFor(current, check.garment_id, batch.org_id, batch.store_id);
          return check.outcome === "rework" && garment !== null
            ? [
                Object.freeze({
                  incident_id: newId(),
                  garment_id: garment.garment_id,
                  order_id: garment.order_id,
                  kind: "rework" as const,
                  compensation_cents: 0,
                  created_at: input.at,
                }),
              ]
            : [];
        });
        const nextBatch = Object.freeze({
          ...batch,
          version: batch.version + 1,
          updated_at: input.at,
        });
        const next = Object.freeze({
          ...current,
          garments: Object.freeze(garments),
          members: Object.freeze(members),
          quality: Object.freeze([...current.quality, ...qualities]),
          incidents: Object.freeze([...current.incidents, ...incidents]),
          batches: Object.freeze(
            current.batches.map((candidate) =>
              candidate.batch_id === batch.batch_id ? nextBatch : candidate,
            ),
          ),
        });
        const passCount = input.checks.filter((check) => check.outcome === "pass").length;
        return [
          next,
          Object.freeze({
            ...factoryMutation(next, nextBatch),
            pass_count: passCount,
            rework_count: input.checks.length - passCount,
          }),
        ] as const;
      });
    },

    async listFactoryBatches(orgId, storeId, options) {
      const snapshot = state.read();
      const statuses = options.statuses === undefined ? null : new Set(options.statuses);
      const batches = snapshot.batches
        .filter(
          (batch) =>
            batch.org_id === orgId &&
            batch.store_id === storeId &&
            (statuses === null || statuses.has(batch.status)),
        )
        .sort((left, right) => right.updated_at - left.updated_at)
        .slice(0, options.limit)
        .map((batch) => batchListRow(snapshot, batch));
      const eligible = snapshot.garments
        .filter(
          (garment) =>
            garment.org_id === orgId &&
            garment.store_id === storeId &&
            garment.order_status === "open" &&
            garment.customer_pii_purged_at === null &&
            (garment.status === "received" || garment.status === "reworked") &&
            garment.custody_state === "store" &&
            garment.active_production_batch_id === null,
        )
        .sort((left, right) => left.garment_id.localeCompare(right.garment_id))
        .slice(0, 100)
        .map((garment) =>
          Object.freeze({
            garment_id: garment.garment_id,
            order_id: garment.order_id,
            ticket_no: garment.ticket_no,
            barcode: garment.barcode,
            status: garment.status,
            custody_state: garment.custody_state,
          }),
        );
      return Object.freeze({
        batches: Object.freeze(batches),
        eligible_garments: Object.freeze(eligible),
      });
    },

    async getFactoryBatch(orgId, storeId, batchId) {
      const snapshot = state.read();
      const batch = scopedBatch(snapshot, orgId, storeId, batchId);
      if (batch === null) return null;
      const checkpoint = expectedCheckpoint(batch.status);
      const attempts = snapshot.attempts.filter(
        (attempt) =>
          attempt.batch_id === batchId &&
          attempt.batch_version === batch.version &&
          checkpoint !== null &&
          attempt.checkpoint === checkpoint,
      );
      const latest = attempts.at(-1);
      const latestAttempt =
        latest === undefined
          ? null
          : Object.freeze({
              attempt_id: latest.attempt_id,
              checkpoint: latest.checkpoint,
              outcome: latest.outcome,
              matched_barcodes: Object.freeze(
                latest.items
                  .filter((item) => item.outcome === "matched")
                  .map((item) => item.barcode)
                  .sort(),
              ),
              missing_barcodes: Object.freeze(
                latest.items
                  .filter((item) => item.outcome === "missing")
                  .map((item) => item.barcode)
                  .sort(),
              ),
              unexpected_barcodes: Object.freeze(
                latest.items
                  .filter((item) => item.outcome === "unexpected")
                  .map((item) => item.barcode)
                  .sort(),
              ),
              recorded_at: latest.recorded_at,
            });
      return Object.freeze({
        batch: batchListRow(snapshot, batch),
        manifest: Object.freeze(manifestFor(snapshot, batchId)),
        checkpoints: Object.freeze(
          snapshot.checkpoints
            .filter((row) => row.batch_id === batchId)
            .map((row) =>
              Object.freeze({
                checkpoint: row.checkpoint,
                completed_at: row.completed_at,
                matched_count: row.matched_count,
                missing_count: row.missing_count,
                unexpected_count: row.unexpected_count,
              }),
            ),
        ),
        latest_attempt: latestAttempt,
        quality_checks: Object.freeze(
          snapshot.quality
            .filter((row) => row.batch_id === batchId)
            .sort((left, right) => right.inspected_at - left.inspected_at)
            .slice(0, 100)
            .map((row) =>
              Object.freeze({
                garment_id: row.garment_id,
                outcome: row.outcome,
                reason_code: row.reason_code,
                inspected_at: row.inspected_at,
              }),
            ),
        ),
      });
    },
  });
}
