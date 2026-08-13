/**
 * HTTP command port → POST /v1/commands/:name (local server).
 */

import type {
  CommandExecutionOptions,
  CommandFailure,
  CommandPort,
  CommandResult,
} from "./types.js";
import { readConfirmationSummary } from "./confirmation-summary.js";
import { requestFailureResult } from "./request-abort.js";

/** Matches packages/contracts CSRF_HEADER_NAME. */
const CSRF_HEADER_NAME = "x-csrf-token";
const IDEMPOTENCY_HEADER_NAME = "idempotency-key";
const MAX_PENDING_IDEMPOTENCY_KEYS = 128;

export type HttpCommandClientOptions = Readonly<{
  apiBaseUrl: string;
  getAccessToken: () => string | null;
  /** Optional override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional CSRF reader (defaults to document.cookie). */
  readCsrf?: () => string | null;
  /** Deterministic UUID source for tests; browser crypto is the production default. */
  newIdempotencyKey?: () => string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReadCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const match = /(?:^|;\s*)(?:__Host-laundry_csrf|laundry_csrf)=([^;]+)/u.exec(document.cookie);
  return match?.[1] ?? null;
}

function defaultIdempotencyKey(): string {
  return crypto.randomUUID();
}

function requestFingerprint(name: string, body: unknown): string {
  return `${name}\n${JSON.stringify(body ?? {})}`;
}

function rememberBounded(map: Map<string, string>, key: string, value: string): void {
  if (!map.has(key) && map.size >= MAX_PENDING_IDEMPOTENCY_KEYS) {
    const oldest = map.keys().next().value;
    if (typeof oldest === "string") map.delete(oldest);
  }
  map.set(key, value);
}

function parseFailure(body: unknown): CommandFailure {
  if (!isRecord(body) || !isRecord(body.error)) {
    return Object.freeze({ code: "COMMAND_FAILED", message: "命令失败" });
  }
  const err = body.error;
  const code = typeof err.code === "string" ? err.code : "COMMAND_FAILED";
  const message = typeof err.message === "string" ? err.message : undefined;
  let detail: CommandFailure["detail"];
  if (isRecord(err.detail)) {
    const summary =
      err.detail.summary === undefined ? undefined : readConfirmationSummary(err.detail.summary);
    if (summary !== null) {
      detail = Object.freeze({
        ...(typeof err.detail.kind === "string" ? { kind: err.detail.kind } : {}),
        ...(typeof err.detail.confirm_ref === "string"
          ? { confirm_ref: err.detail.confirm_ref }
          : {}),
        ...(typeof err.detail.message === "string" ? { message: err.detail.message } : {}),
        ...(summary === undefined ? {} : { summary }),
      });
    }
  }
  return Object.freeze({
    code,
    ...(message !== undefined ? { message } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
}

function isDefinitiveFailure(status: number, body: unknown, failure: CommandFailure): boolean {
  if (
    status >= 500 ||
    failure.code === "TRANSACTION_FAILED" ||
    failure.code === "EVENT_DISPATCH_FAILED"
  ) {
    return false;
  }
  return (
    isRecord(body) &&
    body.ok === false &&
    isRecord(body.error) &&
    typeof body.error.code === "string"
  );
}

/** True when policy wants a WYSIWYS confirm_ref second hop. */
export function isStepUpRequired(result: CommandResult): result is {
  ok: false;
  error: CommandFailure & { detail: { confirm_ref: string } };
} {
  if (result.ok) return false;
  const code = result.error.code;
  if (code !== "POLICY_STEP_UP_REQUIRED" && code !== "POLICY_CONFIRMATION_REQUIRED") {
    return false;
  }
  const ref = result.error.detail?.confirm_ref;
  return typeof ref === "string" && ref.length > 0;
}

export function createHttpCommandClient(options: HttpCommandClientOptions): CommandPort {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const readCsrf = options.readCsrf ?? defaultReadCsrf;
  const newIdempotencyKey = options.newIdempotencyKey ?? defaultIdempotencyKey;
  const uncertainDirectKeys = new Map<string, string>();
  const confirmationKeys = new Map<string, string>();

  return Object.freeze({
    async execute<T = unknown>(
      name: string,
      body: unknown = {},
      execOptions: CommandExecutionOptions = {},
    ): Promise<CommandResult<T>> {
      const token = options.getAccessToken();
      if (token === null || token.length === 0) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "AUTHENTICATION_FAILED", message: "未登录" }),
        });
      }
      const csrf = readCsrf();
      if (csrf === null) {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "CSRF_REJECTED", message: "缺少 CSRF cookie" }),
        });
      }
      const payload =
        execOptions.confirmRef !== undefined
          ? Object.freeze({ confirm_ref: execOptions.confirmRef })
          : body;
      try {
        const fingerprint =
          execOptions.confirmRef === undefined
            ? requestFingerprint(name, body)
            : `confirm\n${execOptions.confirmRef}`;
        const pendingKeys =
          execOptions.confirmRef === undefined ? uncertainDirectKeys : confirmationKeys;
        const idempotencyKey = pendingKeys.get(fingerprint) ?? newIdempotencyKey();
        rememberBounded(pendingKeys, fingerprint, idempotencyKey);
        const res = await fetchImpl(`${base}/v1/commands/${encodeURIComponent(name)}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            [CSRF_HEADER_NAME]: csrf,
            [IDEMPOTENCY_HEADER_NAME]: idempotencyKey,
          },
          body: JSON.stringify(payload ?? {}),
          ...(execOptions.signal === undefined ? {} : { signal: execOptions.signal }),
        });
        const json: unknown = await res.json();
        if (res.ok && isRecord(json) && json.ok === true) {
          pendingKeys.delete(fingerprint);
          return Object.freeze({ ok: true as const, data: json.data as T });
        }
        const failure = parseFailure(json);
        const confirmRef = failure.detail?.confirm_ref;
        const definitive = isDefinitiveFailure(res.status, json, failure);
        if (definitive) pendingKeys.delete(fingerprint);
        if (definitive && typeof confirmRef === "string" && confirmRef.length > 0) {
          rememberBounded(confirmationKeys, `confirm\n${confirmRef}`, idempotencyKey);
        }
        return Object.freeze({ ok: false as const, error: failure });
      } catch {
        return requestFailureResult(execOptions.signal);
      }
    },
  });
}

/** In-memory command port for SSR/unit tests. */
export function createMockCommandClient(
  handler: CommandPort["execute"] = async () =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "POLICY_STEP_UP_REQUIRED",
        detail: Object.freeze({
          kind: "confirmation",
          confirm_ref: "00000000-0000-4000-8000-000000000099",
        }),
      }),
    }),
): CommandPort {
  return Object.freeze({ execute: handler });
}
