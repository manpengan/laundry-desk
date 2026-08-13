import { AiStreamEventSchema, type AiStreamEvent } from "@laundry/contracts";

const CSRF_HEADER_NAME = "x-csrf-token";

export type AiPanelFailure = Readonly<{
  code: "UNAVAILABLE" | "AUTH" | "CONFLICT" | "NETWORK" | "INVALID_RESPONSE";
  message: string;
}>;

export type AiPanelResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: AiPanelFailure }>;

export type AiPanelPort = Readonly<{
  createSession(): Promise<AiPanelResult<Readonly<{ sessionId: string }>>>;
  createTurn(
    sessionId: string,
    input: Readonly<{ prompt: string; idempotencyKey: string }>,
  ): Promise<AiPanelResult<Readonly<{ turnId: string; replayed: boolean }>>>;
  stream(
    sessionId: string,
    after: number,
    signal: AbortSignal,
    onEvent: (event: AiStreamEvent) => void,
  ): Promise<AiPanelResult<Readonly<{ cursor: number }>>>;
}>;

export type HttpAiPanelPortOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl: typeof fetch;
  getAccessToken: () => string | null;
  readCsrf: () => string | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: AiPanelFailure["code"], message: string): AiPanelResult<never> {
  return Object.freeze({ ok: false as const, error: Object.freeze({ code, message }) });
}

function failureFromStatus(status: number): AiPanelResult<never> {
  if (status === 401 || status === 403) return failure("AUTH", "当前登录无权使用 AI");
  if (status === 409 || status === 429) return failure("CONFLICT", "AI 正忙，请稍后再试");
  return failure("UNAVAILABLE", "AI 未配置或不可用");
}

function headers(options: HttpAiPanelPortOptions, csrf = false): HeadersInit | null {
  const token = options.getAccessToken();
  if (token === null || token.length === 0) return null;
  const result: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (csrf) {
    const proof = options.readCsrf();
    if (proof === null || proof.length === 0) return null;
    result[CSRF_HEADER_NAME] = proof;
    result["content-type"] = "application/json";
  }
  return result;
}

function parseSession(body: unknown): AiPanelResult<Readonly<{ sessionId: string }>> {
  if (
    !isRecord(body) ||
    body.ok !== true ||
    !isRecord(body.data) ||
    typeof body.data.session_id !== "string"
  ) {
    return failure("INVALID_RESPONSE", "AI 服务响应格式错误");
  }
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({ sessionId: body.data.session_id }),
  });
}

function parseTurn(body: unknown): AiPanelResult<Readonly<{ turnId: string; replayed: boolean }>> {
  if (
    !isRecord(body) ||
    body.ok !== true ||
    !isRecord(body.data) ||
    typeof body.data.turn_id !== "string" ||
    typeof body.data.replayed !== "boolean"
  ) {
    return failure("INVALID_RESPONSE", "AI 服务响应格式错误");
  }
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({ turnId: body.data.turn_id, replayed: body.data.replayed }),
  });
}

function framesFrom(buffer: string): Readonly<{ frames: readonly string[]; rest: string }> {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n\n");
  return Object.freeze({ frames: Object.freeze(parts.slice(0, -1)), rest: parts.at(-1) ?? "" });
}

function eventFromFrame(frame: string): AiStreamEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data.length === 0) return null;
  try {
    return AiStreamEventSchema.parse(JSON.parse(data));
  } catch {
    return null;
  }
}

async function readSse(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: AiStreamEvent) => void,
): Promise<AiPanelResult<Readonly<{ cursor: number }>>> {
  if (!response.ok) return failureFromStatus(response.status);
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    return failure("INVALID_RESPONSE", "AI 流式响应格式错误");
  }
  if (response.body === null) return failure("INVALID_RESPONSE", "AI 流没有响应体");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let cursor = 0;
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const parsed = framesFrom(pending);
      pending = parsed.rest;
      for (const frame of parsed.frames) {
        const event = eventFromFrame(frame);
        if (event !== null && event.cursor > cursor) {
          cursor = event.cursor;
          onEvent(event);
        }
      }
      if (chunk.done) break;
    }
    return Object.freeze({ ok: true as const, data: Object.freeze({ cursor }) });
  } catch {
    return signal.aborted
      ? Object.freeze({ ok: true as const, data: Object.freeze({ cursor }) })
      : failure("NETWORK", "AI 流连接中断");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function createHttpAiPanelPort(options: HttpAiPanelPortOptions): AiPanelPort {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  return Object.freeze({
    async createSession() {
      const requestHeaders = headers(options, true);
      if (requestHeaders === null) return failure("AUTH", "当前登录已失效");
      try {
        const response = await options.fetchImpl(`${base}/api/v2/ai/sessions`, {
          method: "POST",
          credentials: "include",
          headers: requestHeaders,
          body: "{}",
        });
        if (!response.ok) return failureFromStatus(response.status);
        return parseSession(await response.json());
      } catch {
        return failure("NETWORK", "无法连接 AI 服务");
      }
    },
    async createTurn(sessionId, input) {
      const requestHeaders = headers(options, true);
      if (requestHeaders === null) return failure("AUTH", "当前登录已失效");
      try {
        const response = await options.fetchImpl(
          `${base}/api/v2/ai/sessions/${encodeURIComponent(sessionId)}/turns`,
          {
            method: "POST",
            credentials: "include",
            headers: requestHeaders,
            body: JSON.stringify({
              idempotency_key: input.idempotencyKey,
              prompt: input.prompt,
              max_output_tokens: 512,
            }),
          },
        );
        if (!response.ok) return failureFromStatus(response.status);
        return parseTurn(await response.json());
      } catch {
        return failure("NETWORK", "无法连接 AI 服务");
      }
    },
    async stream(sessionId, after, signal, onEvent) {
      const requestHeaders = headers(options);
      if (requestHeaders === null) return failure("AUTH", "当前登录已失效");
      try {
        const response = await options.fetchImpl(
          `${base}/api/v2/ai/sessions/${encodeURIComponent(sessionId)}/stream`,
          {
            method: "GET",
            credentials: "include",
            headers: {
              ...requestHeaders,
              accept: "text/event-stream",
              "last-event-id": String(after),
            },
            signal,
          },
        );
        return readSse(response, signal, onEvent);
      } catch {
        return signal.aborted
          ? Object.freeze({ ok: true as const, data: Object.freeze({ cursor: after }) })
          : failure("NETWORK", "AI 流连接中断");
      }
    },
  });
}

export function createUnavailableAiPanelPort(): AiPanelPort {
  const unavailable = async () => failure("UNAVAILABLE", "AI 未配置或不可用");
  return Object.freeze({
    createSession: unavailable,
    createTurn: unavailable,
    stream: unavailable,
  });
}
