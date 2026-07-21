/**
 * B4: deterministic size measurement from command input via RFC 6901 paths.
 * Aligns with contracts ADR-09 size_measures (array_length / numeric_sum / field).
 * Fail-closed: illegal paths, missing segments, wrong types, non-integers, overflow.
 */

const DANGEROUS_PROPERTIES = new Set(["__proto__", "prototype", "constructor"]);
const POINTER_TOKEN = /^(?:[^~]|~0|~1)+$/u;
const ARRAY_INDEX = /^(0|[1-9]\d*)$/u;
const SAFE_PROPERTY_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;

export type ArrayLengthMeasure = {
  readonly kind: "array_length";
  readonly path: string;
};

export type NumericSumMeasure = {
  readonly kind: "numeric_sum";
  readonly path: string;
  readonly field: string;
};

export type FieldMeasure = {
  readonly kind: "field";
  readonly path: string;
};

export type BatchMeasure = ArrayLengthMeasure | NumericSumMeasure;
export type AmountMeasure = FieldMeasure | NumericSumMeasure;

/** ADR-09 size_measures group: at least one of batch/amount at call sites. */
export type SizeMeasures = {
  readonly batch?: BatchMeasure;
  readonly amount?: AmountMeasure;
};

/** Measured batch count and/or amount in integer cents. */
export type MeasuredSizes = {
  readonly batch?: number;
  readonly amount_cents?: number;
};

export type MeasureFailureCode =
  | "empty_measures"
  | "illegal_path"
  | "path_not_found"
  | "type_mismatch"
  | "non_integer"
  | "overflow"
  | "unsafe_property"
  | "illegal_field";

export type MeasureSuccess = {
  readonly ok: true;
  readonly measures: MeasuredSizes;
};

export type MeasureFailure = {
  readonly ok: false;
  readonly code: MeasureFailureCode;
  readonly message: string;
};

export type MeasureResult = MeasureSuccess | MeasureFailure;

type WalkSuccess = { readonly ok: true; readonly value: unknown };
type WalkFailure = MeasureFailure;
type WalkResult = WalkSuccess | WalkFailure;

const fail = (code: MeasureFailureCode, message: string): MeasureFailure =>
  Object.freeze({ ok: false, code, message });

const decodePointerToken = (token: string): string =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

/** Parse a non-root, prototype-safe RFC 6901 pointer into decoded segments. */
export const parseJsonPointer = (path: string): readonly string[] | undefined => {
  if (typeof path !== "string" || !path.startsWith("/")) return undefined;
  const tokens = path.slice(1).split("/");
  if (tokens.length === 0 || tokens.some((token) => token === "" || !POINTER_TOKEN.test(token))) {
    return undefined;
  }
  const segments = tokens.map(decodePointerToken);
  if (segments.some((segment) => DANGEROUS_PROPERTIES.has(segment))) return undefined;
  return segments;
};

const readOwn = (target: object, key: string): unknown => {
  if (DANGEROUS_PROPERTIES.has(key) || !Object.hasOwn(target, key)) return undefined;
  return Reflect.get(target, key);
};

const walkSegment = (current: unknown, segment: string): WalkResult => {
  if (current === null || current === undefined) {
    return fail("path_not_found", `Path segment "${segment}" missing: parent is nullish`);
  }
  if (Array.isArray(current)) {
    if (!ARRAY_INDEX.test(segment)) {
      return fail("illegal_path", `Array index must be a plain decimal, got "${segment}"`);
    }
    const index = Number(segment);
    if (index >= current.length) {
      return fail("path_not_found", `Array index ${index} out of bounds`);
    }
    return Object.freeze({ ok: true, value: current[index] });
  }
  if (typeof current !== "object") {
    return fail("type_mismatch", `Cannot traverse into non-object at segment "${segment}"`);
  }
  if (DANGEROUS_PROPERTIES.has(segment)) {
    return fail("unsafe_property", `Refusing prototype-sensitive segment "${segment}"`);
  }
  if (!Object.hasOwn(current, segment)) {
    return fail("path_not_found", `Own property "${segment}" not found`);
  }
  return Object.freeze({ ok: true, value: readOwn(current, segment) });
};

/** Resolve pointer through own properties only (never the prototype chain). */
export const resolvePointer = (input: unknown, path: string): WalkResult => {
  const segments = parseJsonPointer(path);
  if (segments === undefined) {
    return fail("illegal_path", `Illegal or unsafe JSON Pointer: ${path}`);
  }
  let current: unknown = input;
  for (const segment of segments) {
    const step = walkSegment(current, segment);
    if (!step.ok) return step;
    current = step.value;
  }
  return Object.freeze({ ok: true, value: current });
};

const requireSafeInteger = (value: unknown, label: string): MeasureResult | number => {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    return fail("type_mismatch", `${label} must be a finite number`);
  }
  if (!Number.isInteger(value)) {
    return fail("non_integer", `${label} must be an integer (no float cents)`);
  }
  if (!Number.isSafeInteger(value)) {
    return fail("overflow", `${label} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return value;
};

const addSafeInteger = (left: number, right: number): number | MeasureFailure => {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    return fail("overflow", "numeric_sum exceeded Number.MAX_SAFE_INTEGER");
  }
  return sum;
};

const measureArrayLength = (
  input: unknown,
  measure: ArrayLengthMeasure,
): MeasureResult | number => {
  const resolved = resolvePointer(input, measure.path);
  if (!resolved.ok) return resolved;
  if (!Array.isArray(resolved.value)) {
    return fail("type_mismatch", `array_length path must resolve to an array: ${measure.path}`);
  }
  return resolved.value.length;
};

const isSafeFieldName = (field: string): boolean =>
  SAFE_PROPERTY_KEY.test(field) && !DANGEROUS_PROPERTIES.has(field);

const measureNumericSum = (input: unknown, measure: NumericSumMeasure): MeasureResult | number => {
  if (!isSafeFieldName(measure.field)) {
    return fail("illegal_field", `numeric_sum.field is not a safe property key: ${measure.field}`);
  }
  const resolved = resolvePointer(input, measure.path);
  if (!resolved.ok) return resolved;
  if (!Array.isArray(resolved.value)) {
    return fail("type_mismatch", `numeric_sum path must resolve to an array: ${measure.path}`);
  }

  let total = 0;
  for (let index = 0; index < resolved.value.length; index += 1) {
    const element = resolved.value[index];
    if (element === null || typeof element !== "object" || Array.isArray(element)) {
      return fail("type_mismatch", `numeric_sum element ${index} must be a plain object`);
    }
    if (!Object.hasOwn(element, measure.field)) {
      return fail(
        "path_not_found",
        `numeric_sum field "${measure.field}" missing at index ${index}`,
      );
    }
    const raw = readOwn(element, measure.field);
    const cents = requireSafeInteger(raw, `numeric_sum[${index}].${measure.field}`);
    if (typeof cents !== "number") return cents;
    const next = addSafeInteger(total, cents);
    if (typeof next !== "number") return next;
    total = next;
  }
  return total;
};

const measureFieldAmount = (input: unknown, measure: FieldMeasure): MeasureResult | number => {
  const resolved = resolvePointer(input, measure.path);
  if (!resolved.ok) return resolved;
  return requireSafeInteger(resolved.value, `field ${measure.path}`);
};

const measureBatch = (input: unknown, measure: BatchMeasure): MeasureResult | number => {
  if (measure.kind === "array_length") return measureArrayLength(input, measure);
  return measureNumericSum(input, measure);
};

const measureAmount = (input: unknown, measure: AmountMeasure): MeasureResult | number => {
  if (measure.kind === "field") return measureFieldAmount(input, measure);
  return measureNumericSum(input, measure);
};

const freezeMeasures = (
  batch: number | undefined,
  amountCents: number | undefined,
): MeasuredSizes => {
  const measures: { batch?: number; amount_cents?: number } = {};
  if (batch !== undefined) measures.batch = batch;
  if (amountCents !== undefined) measures.amount_cents = amountCents;
  return Object.freeze(measures);
};

/**
 * Evaluate declared size_measures against command input.
 * Order is independent of thresholds; callers must run this before hard_limits / escalation.
 */
export function measureInput(input: unknown, sizeMeasures: SizeMeasures): MeasureResult {
  if (sizeMeasures.batch === undefined && sizeMeasures.amount === undefined) {
    return fail("empty_measures", "A size measure group must declare batch or amount");
  }

  let batch: number | undefined;
  if (sizeMeasures.batch !== undefined) {
    const result = measureBatch(input, sizeMeasures.batch);
    if (typeof result !== "number") return result;
    batch = result;
  }

  let amountCents: number | undefined;
  if (sizeMeasures.amount !== undefined) {
    const result = measureAmount(input, sizeMeasures.amount);
    if (typeof result !== "number") return result;
    amountCents = result;
  }

  return Object.freeze({
    ok: true,
    measures: freezeMeasures(batch, amountCents),
  });
}
