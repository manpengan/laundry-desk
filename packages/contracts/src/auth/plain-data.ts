export type PlainData =
  null | boolean | number | string | readonly PlainData[] | { readonly [key: string]: PlainData };

const MAX_PLAIN_DATA_DEPTH = 32;
const MAX_PLAIN_DATA_NODES = 10_000;

type SnapshotState = {
  nodes: number;
  readonly ancestors: WeakSet<object>;
};

const hasOwn = (value: object, property: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, property);

const isPlainDataArray = (value: PlainData): value is readonly PlainData[] => Array.isArray(value);

const sameDescriptor = (
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    left.get === right.get &&
    left.set === right.set &&
    Object.is(left.value, right.value)
  );
};

const captureStableDescriptors = (
  input: object,
  label: string,
): Readonly<{
  prototype: object | null;
  descriptors: PropertyDescriptorMap;
  keys: readonly PropertyKey[];
}> => {
  let firstPrototype: object | null;
  let secondPrototype: object | null;
  let firstDescriptors: PropertyDescriptorMap;
  let secondDescriptors: PropertyDescriptorMap;
  try {
    firstPrototype = Object.getPrototypeOf(input);
    firstDescriptors = Object.getOwnPropertyDescriptors(input);
    secondPrototype = Object.getPrototypeOf(input);
    secondDescriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    throw new TypeError(`${label} must expose stable own data properties`);
  }

  const firstKeys = Reflect.ownKeys(firstDescriptors);
  const secondKeys = Reflect.ownKeys(secondDescriptors);
  if (
    firstPrototype !== secondPrototype ||
    firstKeys.length !== secondKeys.length ||
    firstKeys.some(
      (key, index) =>
        key !== secondKeys[index] || !sameDescriptor(firstDescriptors[key], secondDescriptors[key]),
    )
  ) {
    throw new TypeError(`${label} must expose stable own data properties`);
  }

  return Object.freeze({
    prototype: firstPrototype,
    descriptors: firstDescriptors,
    keys: Object.freeze(firstKeys),
  });
};

const requireDataDescriptor = (
  descriptors: PropertyDescriptorMap,
  key: PropertyKey,
  label: string,
): PropertyDescriptor => {
  const descriptor = descriptors[key];
  if (descriptor === undefined || !hasOwn(descriptor, "value")) {
    throw new TypeError(`${label} must be an own data property`);
  }
  return descriptor;
};

const snapshotArray = (
  input: object,
  descriptors: PropertyDescriptorMap,
  keys: readonly PropertyKey[],
  label: string,
  depth: number,
  state: SnapshotState,
): readonly PlainData[] => {
  const lengthDescriptor = requireDataDescriptor(descriptors, "length", `${label}.length`);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PLAIN_DATA_NODES) {
    throw new TypeError(`${label} must have a stable, bounded array length`);
  }

  const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), "length"];
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => typeof key !== "string" || key !== expectedKeys[index])
  ) {
    throw new TypeError(`${label} must be a dense plain array without extra properties`);
  }

  const copy = Array.from({ length }, (_, index) => {
    const key = String(index);
    const descriptor = requireDataDescriptor(descriptors, key, `${label}[${key}]`);
    return snapshotValue(descriptor.value, `${label}[${key}]`, depth + 1, state);
  });
  return Object.freeze(copy);
};

const snapshotObject = (
  descriptors: PropertyDescriptorMap,
  keys: readonly PropertyKey[],
  label: string,
  depth: number,
  state: SnapshotState,
): Readonly<Record<string, PlainData>> => {
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${label} must not contain symbol properties`);
  }

  const entries = keys.map((key) => {
    const stringKey = key as string;
    const descriptor = requireDataDescriptor(descriptors, stringKey, `${label}.${stringKey}`);
    return [
      stringKey,
      snapshotValue(descriptor.value, `${label}.${stringKey}`, depth + 1, state),
    ] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
};

const snapshotValue = (
  input: unknown,
  label: string,
  depth: number,
  state: SnapshotState,
): PlainData => {
  state.nodes += 1;
  if (state.nodes > MAX_PLAIN_DATA_NODES || depth > MAX_PLAIN_DATA_DEPTH) {
    throw new TypeError(`${label} exceeds the plain-data complexity limit`);
  }
  if (
    input === null ||
    typeof input === "boolean" ||
    typeof input === "string" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return input;
  }
  if (typeof input !== "object") {
    throw new TypeError(`${label} must contain only plain data`);
  }
  if (state.ancestors.has(input)) {
    throw new TypeError(`${label} must not contain cycles`);
  }

  const { prototype, descriptors, keys } = captureStableDescriptors(input, label);
  const isArray = prototype === Array.prototype;
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object or array`);
  }

  state.ancestors.add(input);
  try {
    return isArray
      ? snapshotArray(input, descriptors, keys, label, depth, state)
      : snapshotObject(descriptors, keys, label, depth, state);
  } finally {
    state.ancestors.delete(input);
  }
};

/** Captures one immutable descriptor-only copy before any schema or business evaluation. */
export const snapshotPlainData = (input: unknown, label = "input"): PlainData =>
  snapshotValue(input, label, 0, { nodes: 0, ancestors: new WeakSet<object>() });

/** Captures an exact plain object and rejects missing or additional own properties. */
export const snapshotExactPlainObject = <const TKeys extends readonly string[]>(
  input: unknown,
  expectedKeys: TKeys,
  label: string,
): Readonly<Record<TKeys[number], PlainData>> => {
  const snapshot = snapshotPlainData(input, label);
  if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== "object") {
    throw new TypeError(`${label} must be a plain object`);
  }
  const actualKeys = Object.keys(snapshot);
  const expectedKeySet = new Set<string>(expectedKeys);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeySet.has(key))
  ) {
    throw new TypeError(`${label} must contain exactly ${expectedKeys.join(", ")}`);
  }
  return snapshot as Readonly<Record<TKeys[number], PlainData>>;
};

/** Equality for already-snapshotted plain data; object key order is not significant. */
export const plainDataEquals = (left: PlainData, right: PlainData): boolean => {
  if (Object.is(left, right)) return true;
  if (isPlainDataArray(left) || isPlainDataArray(right)) {
    return (
      isPlainDataArray(left) &&
      isPlainDataArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => plainDataEquals(entry, right[index]!))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        hasOwn(right, key) && plainDataEquals(left[key] as PlainData, right[key] as PlainData),
    )
  );
};
