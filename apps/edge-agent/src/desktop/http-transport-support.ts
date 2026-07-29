import {
  createCommandError,
  type AccessSessionResponse,
  type CommandError,
  type DesktopSessionView,
} from "@laundry/contracts";

export const NO_SUCCESS_DATA = Symbol("NO_SUCCESS_DATA");

export type DesktopFailure = Readonly<{
  ok: false;
  error: CommandError;
}>;

export type ResultEnvelope = Readonly<{ ok: boolean }>;

export type AsyncSchema<T> = Readonly<{
  safeParseAsync: (
    input: unknown,
  ) => Promise<Readonly<{ success: true; data: T }> | Readonly<{ success: false }>>;
}>;

export type ParsedInput<T> = Readonly<{ valid: true; data: T }> | Readonly<{ valid: false }>;

export type JsonHttpResponse = Readonly<{
  statusCode: number;
  payload: unknown;
}>;

export type AuthState = Readonly<{
  accessToken: string;
  csrfToken: string;
  sessionView: DesktopSessionView;
  expiresAtMs: number;
}>;

export const VALIDATION_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError("VALIDATION_FAILED"),
});
export const AUTHENTICATION_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError("AUTHENTICATION_FAILED"),
});
export const CSRF_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError("CSRF_REJECTED"),
});
export const RESOURCE_FAILURE: DesktopFailure = Object.freeze({
  ok: false,
  error: createCommandError(
    "RESOURCE_UNAVAILABLE",
    Object.freeze({ kind: "reason", reason: "retry_later" }),
  ),
});

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSuccessData(value: unknown): unknown | typeof NO_SUCCESS_DATA {
  if (!isRecord(value) || value.ok !== true) return NO_SUCCESS_DATA;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "ok") ||
    !Object.prototype.hasOwnProperty.call(value, "data")
  ) {
    return NO_SUCCESS_DATA;
  }
  return value.data;
}

export function isSuccessStatus(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

export async function parseInput<T>(
  schema: AsyncSchema<T>,
  input: unknown,
): Promise<ParsedInput<T>> {
  const parsed = await schema.safeParseAsync(input);
  return parsed.success
    ? Object.freeze({ valid: true as const, data: parsed.data })
    : Object.freeze({ valid: false as const });
}

export async function parseOutput<T extends ResultEnvelope>(
  schema: AsyncSchema<T>,
  candidate: unknown,
): Promise<T | DesktopFailure> {
  const parsed = await schema.safeParseAsync(candidate);
  if (parsed.success) return parsed.data;
  const fallback = await schema.safeParseAsync(RESOURCE_FAILURE);
  return fallback.success ? fallback.data : RESOURCE_FAILURE;
}

export async function parseHttpOutput<T extends ResultEnvelope>(
  schema: AsyncSchema<T>,
  response: JsonHttpResponse | null,
): Promise<T | DesktopFailure> {
  if (response === null) return parseOutput(schema, RESOURCE_FAILURE);
  const parsed = await parseOutput(schema, response.payload);
  if (parsed.ok && (response.statusCode < 200 || response.statusCode >= 300)) {
    return parseOutput(schema, RESOURCE_FAILURE);
  }
  return parsed;
}

export function projectSessionView(
  access: AccessSessionResponse,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    session: Object.freeze({ ...access.session }),
    role: access.role,
    features: Object.freeze({ ...access.features }),
    display: Object.freeze({ ...access.display }),
  });
}

export function projectStaffDirectory(
  data: unknown,
): readonly Readonly<Record<string, unknown>>[] | null {
  if (!Array.isArray(data) || !data.every(isRecord)) return null;
  return Object.freeze(
    data.map((entry) =>
      Object.freeze({
        staff_id: entry.staff_id,
        display_name: entry.display_name,
        role: entry.role,
      }),
    ),
  );
}

export function commandBody(
  input: Readonly<{ body: Readonly<Record<string, unknown>> }> | Readonly<{ confirm_ref: string }>,
): Readonly<Record<string, unknown>> {
  return "confirm_ref" in input
    ? Object.freeze({ confirm_ref: input.confirm_ref })
    : Object.freeze({ ...input.body });
}

export function isAuthenticationFailure(result: ResultEnvelope): boolean {
  const candidate: unknown = result;
  const error = isRecord(candidate) ? candidate.error : null;
  return !result.ok && isRecord(error) && error.code === "AUTHENTICATION_FAILED";
}

export function isSameSession(left: AuthState, right: AuthState): boolean {
  const a = left.sessionView.session;
  const b = right.sessionView.session;
  return (
    a.session_id === b.session_id &&
    a.org_id === b.org_id &&
    a.store_id === b.store_id &&
    a.staff_id === b.staff_id &&
    a.device_id === b.device_id
  );
}
