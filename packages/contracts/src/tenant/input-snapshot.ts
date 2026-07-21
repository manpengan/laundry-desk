type CapturedOwnDataProperties<TKey extends string> = Readonly<Record<TKey, unknown>>;

const MAX_TENANT_KEY_COLUMN_COUNT = 4;

const hasOwn = (value: object, property: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, property);

const capturePropertyDescriptors = <const TKeys extends readonly string[]>(
  input: unknown,
  expectedKeys: TKeys,
  label: string,
): Readonly<Record<TKeys[number], PropertyDescriptor>> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError(`${label} must be a plain object`);
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input) as unknown as PropertyDescriptorMap;
  } catch {
    throw new TypeError(`${label} must expose stable own data properties`);
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }

  const keys: readonly TKeys[number][] = expectedKeys;
  const expectedKeySet = new Set<string>(keys);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== "string" || !expectedKeySet.has(key))
  ) {
    throw new TypeError(`${label} must contain exactly the properties ${expectedKeys.join(", ")}`);
  }

  const capturedDescriptors = {} as Record<TKeys[number], PropertyDescriptor>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    capturedDescriptors[key] = descriptor;
  }
  return Object.freeze(capturedDescriptors);
};

export const captureOwnDataProperties = <const TKeys extends readonly string[]>(
  input: unknown,
  expectedKeys: TKeys,
  label: string,
): CapturedOwnDataProperties<TKeys[number]> => {
  const descriptors = capturePropertyDescriptors(input, expectedKeys, label);
  const captured = {} as Record<TKeys[number], unknown>;
  const keys: readonly TKeys[number][] = expectedKeys;
  for (const key of keys) {
    captured[key] = descriptors[key].value;
  }
  return Object.freeze(captured);
};

export const capturePrimitiveStringProperties = <const TKeys extends readonly string[]>(
  input: unknown,
  expectedKeys: TKeys,
  label: string,
): Readonly<Record<TKeys[number], string>> => {
  const captured = captureOwnDataProperties(input, expectedKeys, label);
  const strings = {} as Record<TKeys[number], string>;
  const keys: readonly TKeys[number][] = expectedKeys;
  for (const key of keys) {
    const value = captured[key];
    if (typeof value !== "string") {
      throw new TypeError(`${label}.${key} must be a primitive string`);
    }
    strings[key] = value;
  }
  return Object.freeze(strings);
};

export const capturePrimitiveStringArray = (input: unknown, label: string): readonly string[] => {
  if (!Array.isArray(input)) {
    throw new TypeError(`${label} must be a dense plain string array`);
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(input);
    descriptors = Object.getOwnPropertyDescriptors(input) as unknown as PropertyDescriptorMap;
  } catch {
    throw new TypeError(`${label} must expose stable own data properties`);
  }

  if (prototype !== Array.prototype) {
    throw new TypeError(`${label} must be a dense plain string array`);
  }

  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    !hasOwn(lengthDescriptor, "value") ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError(`${label} must have a stable array length`);
  }

  const length = lengthDescriptor.value;
  if (length > MAX_TENANT_KEY_COLUMN_COUNT) {
    throw new TypeError(`${label} must contain at most ${MAX_TENANT_KEY_COLUMN_COUNT} entries`);
  }
  const expectedKeys = Object.freeze([
    ...Array.from({ length }, (_, index) => String(index)),
    "length",
  ]);
  const expectedKeySet = new Set<string>(expectedKeys);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== "string" || !expectedKeySet.has(key))
  ) {
    throw new TypeError(`${label} must be a dense plain string array`);
  }

  const captured: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} array index ${index} must be an own data property`);
    }
    if (typeof descriptor.value !== "string") {
      throw new TypeError(`${label} array index ${index} must be a primitive string`);
    }
    captured.push(descriptor.value);
  }
  return Object.freeze(captured);
};
