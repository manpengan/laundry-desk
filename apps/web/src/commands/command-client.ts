/**
 * HTTP command port → POST /v1/commands/:name (local server).
 */

import type { CommandFailure, CommandPort, CommandResult } from "./types.js";

/** Matches packages/contracts CSRF_HEADER_NAME. */
const CSRF_HEADER_NAME = "x-csrf-token";

export type HttpCommandClientOptions = Readonly<{
  apiBaseUrl: string;
  getAccessToken: () => string | null;
  /** Optional override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional CSRF reader (defaults to document.cookie). */
  readCsrf?: () => string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReadCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const match = /(?:^|;\s*)(?:__Host-laundry_csrf|laundry_csrf)=([^;]+)/u.exec(document.cookie);
  return match?.[1] ?? null;
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
    detail = Object.freeze({
      ...(typeof err.detail.kind === "string" ? { kind: err.detail.kind } : {}),
      ...(typeof err.detail.confirm_ref === "string"
        ? { confirm_ref: err.detail.confirm_ref }
        : {}),
      ...(typeof err.detail.message === "string" ? { message: err.detail.message } : {}),
    });
  }
  return Object.freeze({
    code,
    ...(message !== undefined ? { message } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
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

  return Object.freeze({
    async execute<T = unknown>(
      name: string,
      body: unknown = {},
      execOptions: Readonly<{ confirmRef?: string }> = {},
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
        const res = await fetchImpl(`${base}/v1/commands/${encodeURIComponent(name)}`, {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            [CSRF_HEADER_NAME]: csrf,
          },
          body: JSON.stringify(payload ?? {}),
        });
        const json: unknown = await res.json();
        if (isRecord(json) && json.ok === true) {
          return Object.freeze({ ok: true as const, data: json.data as T });
        }
        return Object.freeze({ ok: false as const, error: parseFailure(json) });
      } catch {
        return Object.freeze({
          ok: false as const,
          error: Object.freeze({ code: "NETWORK", message: "无法连接本地服务器" }),
        });
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
