import { createMemoryFactoryBatchMethods } from "./factory-memory-batch-store.js";
import { createMemoryFactoryCheckpointMethods } from "./factory-memory-checkpoint-store.js";
import { createMemoryFactoryQualityReadMethods } from "./factory-memory-quality-read-store.js";
import type { MemoryFulfillmentState } from "./factory-memory-state.js";
import type { FactoryHandoffStore } from "./factory-types.js";

export function createMemoryFactoryHandoffStore(
  state: MemoryFulfillmentState,
  newId: () => string,
): FactoryHandoffStore {
  return Object.freeze({
    ...createMemoryFactoryBatchMethods(state, newId),
    ...createMemoryFactoryCheckpointMethods(state, newId),
    ...createMemoryFactoryQualityReadMethods(state, newId),
  });
}
