import {
  AiApprovalExecutionResponseSchema,
  AiApprovalItemResponseSchema,
  AiApprovalListResponseSchema,
  CommandResponseSchema,
  type AiApprovalView,
} from "@laundry/contracts";

export type ApprovalFailure = Readonly<{ code: string; message: string }>;
export type ApprovalResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: ApprovalFailure }>;

export type ApprovalExecutionView = Readonly<{
  approval: AiApprovalView;
  execution: "executed";
  result: unknown;
}>;

export type ApprovalPort = Readonly<{
  submit(confirmRef: string, signal?: AbortSignal): Promise<ApprovalResult<AiApprovalView>>;
  list(
    scope: "pending" | "history",
    signal?: AbortSignal,
  ): Promise<ApprovalResult<readonly AiApprovalView[]>>;
  get(approvalRef: string, signal?: AbortSignal): Promise<ApprovalResult<AiApprovalView>>;
  approve(
    approvalRef: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<ApprovalResult<ApprovalExecutionView>>;
  deny(
    approvalRef: string,
    expectedVersion: number,
    reason: string,
    signal?: AbortSignal,
  ): Promise<ApprovalResult<AiApprovalView>>;
}>;

type HttpApprovalOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  getAccessToken: () => string | null;
  readCsrf: () => string | null;
}>;

const failure = (code: string, message: string): ApprovalResult<never> =>
  Object.freeze({ ok: false as const, error: Object.freeze({ code, message }) });

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readFailure(value: unknown): ApprovalResult<never> {
  const parsed = CommandResponseSchema.safeParse(value);
  return parsed.success && !parsed.data.ok
    ? failure(parsed.data.error.code, parsed.data.error.message)
    : failure("SERVICE_UNAVAILABLE", "审批服务响应格式错误");
}

export function createHttpApprovalPort(options: HttpApprovalOptions): ApprovalPort {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = async (
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Readonly<{ response: Response; body: unknown }> | ApprovalResult<never>> => {
    const token = options.getAccessToken();
    if (token === null) return failure("AUTHENTICATION_FAILED", "登录状态已失效");
    try {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        credentials: "include",
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      return Object.freeze({ response, body: await readJson(response) });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return failure("SERVICE_UNAVAILABLE", "无法连接审批服务");
    }
  };

  const post = async (
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Readonly<{ response: Response; body: unknown }> | ApprovalResult<never>> => {
    const csrf = options.readCsrf();
    if (csrf === null) return failure("CSRF_REJECTED", "安全校验已失效，请刷新后重试");
    return request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(body),
      },
      signal,
    );
  };

  return Object.freeze({
    async submit(confirmRef, signal) {
      const result = await post(
        "/api/v2/ai/approval-requests",
        { confirm_ref: confirmRef },
        signal,
      );
      if ("ok" in result) return result;
      const parsed = AiApprovalItemResponseSchema.safeParse(result.body);
      return result.response.ok && parsed.success
        ? Object.freeze({ ok: true as const, data: parsed.data.data })
        : readFailure(result.body);
    },

    async list(scope, signal) {
      const result = await request(
        `/api/v2/ai/approval-requests?status=${scope}&limit=50`,
        { method: "GET" },
        signal,
      );
      if ("ok" in result) return result;
      const parsed = AiApprovalListResponseSchema.safeParse(result.body);
      return result.response.ok && parsed.success
        ? Object.freeze({ ok: true as const, data: Object.freeze(parsed.data.data.items) })
        : readFailure(result.body);
    },

    async get(approvalRef, signal) {
      const result = await request(
        `/api/v2/ai/approval-requests/${encodeURIComponent(approvalRef)}`,
        { method: "GET" },
        signal,
      );
      if ("ok" in result) return result;
      const parsed = AiApprovalItemResponseSchema.safeParse(result.body);
      return result.response.ok && parsed.success
        ? Object.freeze({ ok: true as const, data: parsed.data.data })
        : readFailure(result.body);
    },

    async approve(approvalRef, expectedVersion, signal) {
      const result = await post(
        `/api/v2/ai/approval-requests/${encodeURIComponent(approvalRef)}/approve`,
        { expected_version: expectedVersion },
        signal,
      );
      if ("ok" in result) return result;
      const parsed = AiApprovalExecutionResponseSchema.safeParse(result.body);
      return result.response.ok && parsed.success
        ? Object.freeze({ ok: true as const, data: parsed.data.data })
        : readFailure(result.body);
    },

    async deny(approvalRef, expectedVersion, reason, signal) {
      const result = await post(
        `/api/v2/ai/approval-requests/${encodeURIComponent(approvalRef)}/deny`,
        { expected_version: expectedVersion, reason },
        signal,
      );
      if ("ok" in result) return result;
      const parsed = AiApprovalItemResponseSchema.safeParse(result.body);
      return result.response.ok && parsed.success
        ? Object.freeze({ ok: true as const, data: parsed.data.data })
        : readFailure(result.body);
    },
  });
}
