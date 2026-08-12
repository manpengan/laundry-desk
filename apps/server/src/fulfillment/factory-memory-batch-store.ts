import { factoryManifestDigest } from "./factory-manifest.js";
import type {
  MemoryFactoryBatch,
  MemoryFactoryMember,
  MemoryFulfillmentState,
} from "./factory-memory-state.js";
import {
  canAdvanceFactoryDispatch,
  checkpointSets,
  expectedCheckpoint,
  factoryMutation,
  hasUnresolvedFactoryDiscrepancy,
  manifestFor,
  membersFor,
  sameStringSet,
  scopedBatch,
  summaryFor,
  validCreateRows,
  ZERO_COUNTS,
} from "./factory-memory-support.js";
import type { FactoryConfirmationCounts, FactoryHandoffStore } from "./factory-types.js";

type BatchMethods = Pick<
  FactoryHandoffStore,
  "prepareFactoryConfirmation" | "createFactoryBatch" | "cancelFactoryBatch"
>;

export function createMemoryFactoryBatchMethods(
  state: MemoryFulfillmentState,
  newId: () => string,
): BatchMethods {
  return Object.freeze({
    async prepareFactoryConfirmation(request) {
      const snapshot = state.read();
      if (request.operation === "batch_create") {
        const rows = validCreateRows(
          snapshot,
          request.input.org_id,
          request.input.store_id,
          request.input.garment_ids,
        );
        if (rows === null) return null;
        const manifest = rows.map((row) =>
          Object.freeze({ ...row, member_state: "active" as const, qc_status: "pending" as const }),
        );
        return summaryFor(snapshot, {
          operation: request.operation,
          batch: null,
          factoryCode: request.input.factory_code,
          expectedVersion: null,
          checkpoint: null,
          manifest,
        });
      }
      const input = request.input;
      const batch = scopedBatch(snapshot, input.org_id, input.store_id, input.batch_id);
      if (batch === null || batch.version !== input.expected_version) return null;
      const manifest = manifestFor(snapshot, batch.batch_id);
      const activeManifest = manifest.filter((row) => row.member_state === "active");
      if (request.operation === "batch_cancel") {
        if (batch.status !== "packing") return null;
        return summaryFor(snapshot, {
          operation: request.operation,
          batch,
          factoryCode: batch.factory_code,
          expectedVersion: input.expected_version,
          checkpoint: null,
          manifest,
        });
      }
      if (request.operation === "checkpoint_record") {
        const sets = checkpointSets(snapshot, request.input);
        const unresolved = hasUnresolvedFactoryDiscrepancy(
          snapshot,
          batch.batch_id,
          batch.version,
          request.input.checkpoint,
        );
        if (
          sets === null ||
          unresolved ||
          expectedCheckpoint(batch.status) !== request.input.checkpoint ||
          (request.input.checkpoint === "factory_dispatch" &&
            !sets.manifest.every((row) => row.qc_status === "pass" && row.status === "ready"))
        )
          return null;
        return summaryFor(snapshot, {
          operation: request.operation,
          batch,
          factoryCode: batch.factory_code,
          expectedVersion: input.expected_version,
          checkpoint: request.input.checkpoint,
          manifest: activeManifest,
          digestManifest: manifest,
          counts: sets.counts,
        });
      }
      if (request.operation === "discrepancy_resolve") {
        const currentCheckpoint = expectedCheckpoint(batch.status);
        const attempt = [...snapshot.attempts]
          .reverse()
          .find(
            (row) => row.batch_id === batch.batch_id && row.attempt_id === request.input.attempt_id,
          );
        const latest = [...snapshot.attempts]
          .reverse()
          .find(
            (row) =>
              row.batch_id === batch.batch_id &&
              row.batch_version === batch.version &&
              currentCheckpoint !== null &&
              row.checkpoint === currentCheckpoint,
          );
        if (
          attempt === undefined ||
          attempt.outcome !== "discrepancy" ||
          latest?.attempt_id !== attempt.attempt_id ||
          attempt.batch_version !== batch.version ||
          snapshot.resolutions.some((row) => row.attempt_id === attempt.attempt_id) ||
          currentCheckpoint !== attempt.checkpoint
        ) {
          return null;
        }
        if (!attempt.items.some((item) => item.outcome === "matched")) return null;
        const matchedIds = attempt.items.flatMap((item) =>
          item.outcome === "matched" && item.garment_id !== null ? [item.garment_id] : [],
        );
        if (
          attempt.checkpoint === "factory_dispatch" &&
          !canAdvanceFactoryDispatch(snapshot, batch.batch_id, matchedIds)
        ) {
          return null;
        }
        const missing = attempt.items.filter((item) => item.outcome === "missing");
        if (
          !sameStringSet(
            request.input.garment_ids,
            missing.flatMap((item) => item.garment_id ?? []),
          )
        ) {
          return null;
        }
        const counts: FactoryConfirmationCounts = Object.freeze({
          ...ZERO_COUNTS,
          manifest_count: manifestFor(snapshot, batch.batch_id, true).length,
          scan_count: attempt.items.filter((item) => item.outcome !== "missing").length,
          matched_count: attempt.items.filter((item) => item.outcome === "matched").length,
          missing_count: missing.length,
          unexpected_count: attempt.items.filter((item) => item.outcome === "unexpected").length,
        });
        return summaryFor(snapshot, {
          operation: request.operation,
          batch,
          factoryCode: batch.factory_code,
          expectedVersion: input.expected_version,
          checkpoint: attempt.checkpoint,
          manifest: activeManifest,
          digestManifest: manifest,
          counts,
        });
      }
      if (request.operation === "quality_check") {
        const passCount = request.input.checks.filter((check) => check.outcome === "pass").length;
        const checked = new Set(request.input.garment_ids);
        const checkedManifest = activeManifest.filter((row) => checked.has(row.garment_id));
        const checkById = new Map(request.input.checks.map((check) => [check.garment_id, check]));
        if (
          batch.status !== "factory_received" ||
          hasUnresolvedFactoryDiscrepancy(
            snapshot,
            batch.batch_id,
            batch.version,
            "factory_dispatch",
          ) ||
          !sameStringSet(
            request.input.garment_ids,
            request.input.checks.map((check) => check.garment_id),
          ) ||
          checkedManifest.length !== checked.size ||
          checkedManifest.some((row) => {
            const check = checkById.get(row.garment_id);
            return (
              check === undefined ||
              row.custody_state !== "factory" ||
              !["washing", "reworked", "ready"].includes(row.status)
            );
          })
        ) {
          return null;
        }
        const counts: FactoryConfirmationCounts = Object.freeze({
          ...ZERO_COUNTS,
          manifest_count: manifest.length,
          pass_count: passCount,
          rework_count: request.input.checks.length - passCount,
        });
        return summaryFor(snapshot, {
          operation: request.operation,
          batch,
          factoryCode: batch.factory_code,
          expectedVersion: input.expected_version,
          checkpoint: null,
          manifest: checkedManifest,
          digestManifest: manifest,
          counts,
        });
      }
      return null;
    },

    async createFactoryBatch(input) {
      return state.mutate((current) => {
        const rows = validCreateRows(current, input.org_id, input.store_id, input.garment_ids);
        if (rows === null || input.device_id === null) return [current, null] as const;
        const batchId = newId();
        const manifestDigest = factoryManifestDigest(rows);
        if (
          input.expected_manifest_digest !== undefined &&
          input.expected_manifest_digest !== manifestDigest
        ) {
          return [current, null] as const;
        }
        const batch: MemoryFactoryBatch = Object.freeze({
          batch_id: batchId,
          org_id: input.org_id,
          store_id: input.store_id,
          factory_code: input.factory_code,
          status: "packing",
          version: 1,
          manifest_digest: manifestDigest,
          exception_count: 0,
          cancel_reason: null,
          created_at: input.at,
          updated_at: input.at,
        });
        const selected = new Set(input.garment_ids);
        const garments = current.garments.map((garment) =>
          garment.org_id === input.org_id &&
          garment.store_id === input.store_id &&
          selected.has(garment.garment_id)
            ? Object.freeze({ ...garment, active_production_batch_id: batchId })
            : garment,
        );
        const members: readonly MemoryFactoryMember[] = rows.map((garment) =>
          Object.freeze({
            batch_id: batchId,
            garment_id: garment.garment_id,
            order_id: garment.order_id,
            member_state: "active" as const,
            qc_status: "pending" as const,
          }),
        );
        const next = Object.freeze({
          ...current,
          garments: Object.freeze(garments),
          batches: Object.freeze([...current.batches, batch]),
          members: Object.freeze([...current.members, ...members]),
        });
        return [next, factoryMutation(next, batch)] as const;
      });
    },

    async cancelFactoryBatch(input) {
      return state.mutate((current) => {
        const batch = scopedBatch(current, input.org_id, input.store_id, input.batch_id);
        const digest =
          batch === null ? null : factoryManifestDigest(manifestFor(current, batch.batch_id));
        if (
          batch === null ||
          batch.status !== "packing" ||
          batch.version !== input.expected_version ||
          input.device_id === null ||
          (input.expected_manifest_digest !== undefined &&
            input.expected_manifest_digest !== digest)
        ) {
          return [current, null] as const;
        }
        const selected = new Set(
          membersFor(current, batch.batch_id, true).map((row) => row.garment_id),
        );
        const garments = current.garments.map((garment) =>
          garment.org_id === batch.org_id &&
          garment.store_id === batch.store_id &&
          selected.has(garment.garment_id)
            ? Object.freeze({
                ...garment,
                custody_state: "store" as const,
                active_production_batch_id: null,
              })
            : garment,
        );
        const members = current.members.map((member) =>
          member.batch_id === batch.batch_id && member.member_state === "active"
            ? Object.freeze({ ...member, member_state: "completed" as const })
            : member,
        );
        const nextBatch = Object.freeze({
          ...batch,
          status: "cancelled" as const,
          version: batch.version + 1,
          cancel_reason: input.reason_code,
          updated_at: input.at,
        });
        const next = Object.freeze({
          ...current,
          garments: Object.freeze(garments),
          members: Object.freeze(members),
          batches: Object.freeze(
            current.batches.map((candidate) =>
              candidate.batch_id === batch.batch_id ? nextBatch : candidate,
            ),
          ),
        });
        return [next, factoryMutation(next, nextBatch)] as const;
      });
    },
  });
}
