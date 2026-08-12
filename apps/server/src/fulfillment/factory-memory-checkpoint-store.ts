import { factoryManifestDigest } from "./factory-manifest.js";
import type {
  MemoryFactoryAttempt,
  MemoryFulfillmentSnapshot,
  MemoryFulfillmentState,
} from "./factory-memory-state.js";
import {
  advanceMatched,
  attemptItems,
  canAdvanceFactoryDispatch,
  checkpointSets,
  expectedCheckpoint,
  factoryMutation,
  hasUnresolvedFactoryDiscrepancy,
  manifestFor,
  sameStringSet,
  scopedBatch,
} from "./factory-memory-support.js";
import type { FactoryCheckpointResult, FactoryHandoffStore } from "./factory-types.js";

type CheckpointMethods = Pick<
  FactoryHandoffStore,
  "recordFactoryCheckpoint" | "resolveFactoryDiscrepancy"
>;

export function createMemoryFactoryCheckpointMethods(
  state: MemoryFulfillmentState,
  newId: () => string,
): CheckpointMethods {
  return Object.freeze({
    async recordFactoryCheckpoint(input) {
      return state.mutate((current) => {
        const batch = scopedBatch(current, input.org_id, input.store_id, input.batch_id);
        const sets = checkpointSets(current, input);
        const digest =
          batch === null ? null : factoryManifestDigest(manifestFor(current, batch.batch_id));
        const unresolvedDiscrepancy =
          batch !== null &&
          hasUnresolvedFactoryDiscrepancy(current, batch.batch_id, batch.version, input.checkpoint);
        if (
          batch === null ||
          sets === null ||
          unresolvedDiscrepancy ||
          input.device_id === null ||
          batch.version !== input.expected_version ||
          expectedCheckpoint(batch.status) !== input.checkpoint ||
          (input.expected_manifest_digest !== undefined &&
            input.expected_manifest_digest !== digest) ||
          (input.checkpoint === "factory_dispatch" &&
            !canAdvanceFactoryDispatch(
              current,
              batch.batch_id,
              sets.manifest.map((row) => row.garment_id),
            ))
        ) {
          return [current, null] as const;
        }
        const attemptId = newId();
        const exact = sets.counts.missing_count === 0 && sets.counts.unexpected_count === 0;
        const attempt: MemoryFactoryAttempt = Object.freeze({
          attempt_id: attemptId,
          batch_id: batch.batch_id,
          batch_version: batch.version,
          checkpoint: input.checkpoint,
          outcome: exact ? "matched" : "discrepancy",
          items: attemptItems(sets),
          recorded_at: input.at,
        });
        let next: MemoryFulfillmentSnapshot = Object.freeze({
          ...current,
          attempts: Object.freeze([...current.attempts, attempt]),
        });
        let nextBatch = batch;
        if (exact) {
          const advanced = advanceMatched(
            next,
            batch,
            input.checkpoint,
            sets.matched.map((row) => row.garment_id),
            [],
            input.at,
          );
          nextBatch = advanced.nextBatch;
          next = Object.freeze({
            ...next,
            garments: advanced.garments,
            members: advanced.members,
            checkpoints: Object.freeze([
              ...next.checkpoints,
              Object.freeze({
                batch_id: batch.batch_id,
                checkpoint: input.checkpoint,
                attempt_id: attemptId,
                outcome: "matched" as const,
                matched_count: sets.counts.matched_count,
                missing_count: 0,
                unexpected_count: 0,
                completed_at: input.at,
              }),
            ]),
          });
        }
        if (exact) {
          next = Object.freeze({
            ...next,
            batches: Object.freeze(
              next.batches.map((candidate) =>
                candidate.batch_id === batch.batch_id ? nextBatch : candidate,
              ),
            ),
          });
        }
        const result: FactoryCheckpointResult = Object.freeze({
          ...factoryMutation(next, nextBatch),
          checkpoint: input.checkpoint,
          attempt_id: attemptId,
          outcome: exact ? "matched" : "discrepancy",
          matched_count: sets.counts.matched_count,
          missing_count: sets.counts.missing_count,
          unexpected_count: sets.counts.unexpected_count,
        });
        return [next, result] as const;
      });
    },

    async resolveFactoryDiscrepancy(input) {
      return state.mutate((current) => {
        const batch = scopedBatch(current, input.org_id, input.store_id, input.batch_id);
        const attempt = current.attempts.find(
          (row) => row.batch_id === input.batch_id && row.attempt_id === input.attempt_id,
        );
        const currentCheckpoint = batch === null ? null : expectedCheckpoint(batch.status);
        const latest = [...current.attempts]
          .reverse()
          .find(
            (row) =>
              row.batch_id === input.batch_id &&
              batch !== null &&
              row.batch_version === batch.version &&
              currentCheckpoint !== null &&
              row.checkpoint === currentCheckpoint,
          );
        const missingIds =
          attempt?.items.flatMap((item) =>
            item.outcome === "missing" && item.garment_id !== null ? [item.garment_id] : [],
          ) ?? [];
        const digest =
          batch === null ? null : factoryManifestDigest(manifestFor(current, batch.batch_id));
        if (
          batch === null ||
          attempt === undefined ||
          attempt.outcome !== "discrepancy" ||
          latest?.attempt_id !== attempt.attempt_id ||
          current.resolutions.some((row) => row.attempt_id === attempt.attempt_id) ||
          input.device_id === null ||
          batch.version !== input.expected_version ||
          attempt.batch_version !== batch.version ||
          currentCheckpoint !== attempt.checkpoint ||
          !sameStringSet(input.garment_ids, missingIds) ||
          (input.expected_manifest_digest !== undefined &&
            input.expected_manifest_digest !== digest)
        ) {
          return [current, null] as const;
        }
        const matchedIds = attempt.items.flatMap((item) =>
          item.outcome === "matched" && item.garment_id !== null ? [item.garment_id] : [],
        );
        if (
          matchedIds.length === 0 ||
          (attempt.checkpoint === "factory_dispatch" &&
            !canAdvanceFactoryDispatch(current, batch.batch_id, matchedIds))
        ) {
          return [current, null] as const;
        }
        const advanced = advanceMatched(
          current,
          batch,
          attempt.checkpoint,
          matchedIds,
          missingIds,
          input.at,
        );
        const missingCount = missingIds.length;
        const unexpectedCount = attempt.items.filter(
          (item) => item.outcome === "unexpected",
        ).length;
        const next = Object.freeze({
          ...current,
          garments: advanced.garments,
          members: advanced.members,
          batches: Object.freeze(
            current.batches.map((candidate) =>
              candidate.batch_id === batch.batch_id ? advanced.nextBatch : candidate,
            ),
          ),
          checkpoints: Object.freeze([
            ...current.checkpoints,
            Object.freeze({
              batch_id: batch.batch_id,
              checkpoint: attempt.checkpoint,
              attempt_id: attempt.attempt_id,
              outcome: "reconciled" as const,
              matched_count: matchedIds.length,
              missing_count: missingCount,
              unexpected_count: unexpectedCount,
              completed_at: input.at,
            }),
          ]),
          resolutions: Object.freeze([
            ...current.resolutions,
            Object.freeze({
              batch_id: batch.batch_id,
              attempt_id: attempt.attempt_id,
              reason_code: input.reason_code,
              resolved_at: input.at,
            }),
          ]),
        });
        const result: FactoryCheckpointResult = Object.freeze({
          ...factoryMutation(next, advanced.nextBatch),
          checkpoint: attempt.checkpoint,
          attempt_id: attempt.attempt_id,
          matched_count: matchedIds.length,
          missing_count: missingCount,
          unexpected_count: unexpectedCount,
        });
        return [next, result] as const;
      });
    },
  });
}
