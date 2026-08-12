import { AsyncLocalStorage } from "node:async_hooks";

type MemoryStateEntry = Readonly<{
  base: unknown;
  value: unknown;
  readCommitted: () => unknown;
  publish: (value: unknown) => void;
}>;

type MemoryUnitOfWork = Readonly<{
  states: Map<object, MemoryStateEntry>;
  rollbacks: Array<() => void>;
  commits: Array<Readonly<{ validate: () => boolean; publish: () => void }>>;
}>;

const memoryUnitOfWork = new AsyncLocalStorage<MemoryUnitOfWork>();

export class MemoryTransactionConflictError extends Error {
  override readonly name = "MemoryTransactionConflictError";
}

/**
 * Stage process-local business state until the surrounding SQL transaction commits.
 * Immediate CAS stores can instead register precise inverse operations.
 */
export async function runWithMemoryUnitOfWork<T>(operation: () => Promise<T>): Promise<T> {
  if (memoryUnitOfWork.getStore() !== undefined) return operation();
  const context: MemoryUnitOfWork = Object.freeze({
    states: new Map(),
    rollbacks: [],
    commits: [],
  });
  return memoryUnitOfWork.run(context, async () => {
    try {
      const result = await operation();
      commitStagedStates(context);
      return result;
    } catch (error) {
      rollbackImmediateChanges(context, error);
    }
  });
}

export function readMemoryTransactionState<T>(owner: object, committed: T): T {
  const entry = memoryUnitOfWork.getStore()?.states.get(owner);
  return entry === undefined ? committed : (entry.value as T);
}

export function writeMemoryTransactionState<T>(
  owner: object,
  readCommitted: () => T,
  next: T,
  publish: (value: T) => void,
): void {
  const committed = readCommitted();
  const context = memoryUnitOfWork.getStore();
  if (context === undefined) {
    publish(next);
    return;
  }
  const existing = context.states.get(owner);
  context.states.set(
    owner,
    Object.freeze({
      base: existing?.base ?? committed,
      value: next,
      readCommitted: existing?.readCommitted ?? readCommitted,
      publish: existing?.publish ?? ((value: unknown) => publish(value as T)),
    }),
  );
}

/** Register a CAS-safe inverse for a map mutation that must stay visible before commit. */
export function registerMemoryRollback(rollback: () => void): void {
  memoryUnitOfWork.getStore()?.rollbacks.push(rollback);
}

/** Keep a completion invisible until the surrounding fake SQL COMMIT succeeds. */
export function registerMemoryCommit(validate: () => boolean, publish: () => void): void {
  const context = memoryUnitOfWork.getStore();
  if (context === undefined) {
    if (!validate()) throw new MemoryTransactionConflictError("Memory commit authority changed");
    publish();
    return;
  }
  context.commits.push(Object.freeze({ validate, publish }));
}

function commitStagedStates(context: MemoryUnitOfWork): void {
  const entries = [...context.states.values()];
  if (entries.some((entry) => !Object.is(entry.readCommitted(), entry.base))) {
    throw new MemoryTransactionConflictError("Concurrent memory transaction changed staged state");
  }
  if (context.commits.some((commit) => !commit.validate())) {
    throw new MemoryTransactionConflictError("Memory commit authority changed");
  }
  for (const entry of entries) entry.publish(entry.value);
  for (const commit of context.commits) commit.publish();
}

function rollbackImmediateChanges(context: MemoryUnitOfWork, original: unknown): never {
  const failures: unknown[] = [];
  for (const rollback of [...context.rollbacks].reverse()) {
    try {
      rollback();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError([original, ...failures], "Memory transaction rollback failed");
  }
  throw original;
}
