import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";

export const ADR36_PUBLIC_ORIGIN = DEFAULT_CLOUD_ENVIRONMENT_PROFILE.endpoints.deskPublicOrigin;

export const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,95}$/u;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class AcceptanceFailure extends Error {
  constructor(code) {
    super(SAFE_CODE.test(code) ? code : "INTERNAL_ERROR");
    this.name = "AcceptanceFailure";
    this.code = SAFE_CODE.test(code) ? code : "INTERNAL_ERROR";
  }
}

export function fail(code) {
  throw new AcceptanceFailure(code);
}

export function failureCode(error) {
  return error instanceof AcceptanceFailure ? error.code : "INTERNAL_ERROR";
}

export function requireThat(condition, code) {
  if (!condition) fail(code);
}

export function asRecord(value, code = "REMOTE_SHAPE_INVALID") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  return value;
}

export function requireString(value, code) {
  requireThat(typeof value === "string" && value.length > 0, code);
  return value;
}

export function requireUuid(value, code) {
  requireThat(typeof value === "string" && UUID.test(value), code);
  return value;
}

export function requireInteger(value, code) {
  requireThat(Number.isSafeInteger(value), code);
  return value;
}
