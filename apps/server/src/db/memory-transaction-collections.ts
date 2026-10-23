import { readMemoryTransactionState, writeMemoryTransactionState } from "./memory-unit-of-work.js";

/** Reads enlist a snapshot too, so a concurrent writer invalidates stale decisions. */
function stagedValue<T>(initial: T) {
  const owner = Object.freeze({});
  let committed = initial;
  const write = (next: T): void => {
    writeMemoryTransactionState(
      owner,
      () => committed,
      next,
      (value) => {
        committed = value;
      },
    );
  };
  const read = (): T => {
    const snapshot = readMemoryTransactionState(owner, committed);
    write(snapshot);
    return snapshot;
  };
  return Object.freeze({ read, write });
}

export type MemoryTransactionMap<TKey, TValue> = Readonly<{
  get: (key: TKey) => TValue | undefined;
  has: (key: TKey) => boolean;
  values: () => IterableIterator<TValue>;
  entries: () => IterableIterator<[TKey, TValue]>;
  [Symbol.iterator]: () => IterableIterator<[TKey, TValue]>;
  set: (key: TKey, value: TValue) => void;
  delete: (key: TKey) => void;
  clear: () => void;
}>;

/** Immutable snapshots publish together only after the complete transaction succeeds. */
export function createMemoryTransactionMap<TKey, TValue>(
  initial: Iterable<readonly [TKey, TValue]> = [],
): MemoryTransactionMap<TKey, TValue> {
  const state = stagedValue<ReadonlyMap<TKey, TValue>>(new Map(initial));
  return Object.freeze({
    get: (key: TKey) => state.read().get(key),
    has: (key: TKey) => state.read().has(key),
    values: () => state.read().values(),
    entries: () => state.read().entries(),
    [Symbol.iterator]: () => state.read().entries(),
    set: (key: TKey, value: TValue) => {
      state.write(new Map([...state.read(), [key, value]]));
    },
    delete: (key: TKey) => {
      state.write(new Map([...state.read()].filter(([existing]) => existing !== key)));
    },
    clear: () => {
      state.write(new Map());
    },
  });
}

/** Append-only list operations never expose or mutate the committed backing array. */
export function createMemoryTransactionList<T>() {
  const state = stagedValue<readonly T[]>(Object.freeze([]));
  return Object.freeze({
    append: (...items: readonly T[]): void => {
      state.write(Object.freeze([...state.read(), ...items]));
    },
    filter: (predicate: (value: T) => boolean): readonly T[] => state.read().filter(predicate),
    some: (predicate: (value: T) => boolean): boolean => state.read().some(predicate),
    clear: (): void => {
      state.write(Object.freeze([]));
    },
  });
}
