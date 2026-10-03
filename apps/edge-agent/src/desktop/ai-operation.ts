import {
  AiStreamEventSchema,
  DesktopAiInputSchema,
  DesktopAiResultSchema,
  type DesktopAiInput,
  type AiStreamEvent,
} from "@laundry/contracts";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  VALIDATION_FAILURE,
  isSameSession,
  type AuthState,
} from "./http-transport-support.js";
import type { DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import { createDesktopRequest } from "./request-builder.js";

export const DESKTOP_AI_OPERATION = Object.freeze({
  input: DesktopAiInputSchema,
  result: DesktopAiResultSchema,
});
type Route = Readonly<{
  path: string;
  method: "GET" | "POST";
  body?: Readonly<Record<string, unknown>>;
}>;
function route(input: DesktopAiInput): Route | null {
  switch (input.operation) {
    case "models":
      return { method: "GET", path: "/api/v2/ai/models" };
    case "credentials":
      return { method: "GET", path: "/api/v2/ai/provider-credentials" };
    case "config":
      return { method: "GET", path: "/api/v2/ai/runtime-config" };
    case "safety":
      return { method: "GET", path: "/api/v2/ai/safety" };
    case "session":
      return { method: "POST", path: "/api/v2/ai/sessions", body: {} };
    case "credentialIntent":
      return { method: "POST", path: "/api/v2/ai/provider-credential-intents", body: input.body };
    case "secret":
      return { method: "POST", path: "/api/v2/ai/provider-credentials/secret", body: input.body };
    case "revoke":
      return {
        method: "POST",
        path: `/api/v2/ai/provider-credentials/${input.credential_ref}/revoke`,
        body: input.body,
      };
    case "validationIntent":
      return { method: "POST", path: "/api/v2/ai/provider-validation-intents", body: input.body };
    case "validate":
      return { method: "POST", path: "/api/v2/ai/provider-connections/validate", body: input.body };
    case "configure":
      return { method: "POST", path: "/api/v2/ai/runtime-config", body: input.body };
    case "turn":
      return {
        method: "POST",
        path: `/api/v2/ai/sessions/${input.session_id}/turns`,
        body: input.body,
      };
    case "stream":
      return { method: "GET", path: `/api/v2/ai/sessions/${input.session_id}/stream` };
    case "cancel":
      return null;
  }
}

function streamResult(text: string, after: number) {
  const events: AiStreamEvent[] = [];
  let cursor = after;
  for (const frame of text.split(/\r?\n\r?\n/u)) {
    const data = frame.split(/\r?\n/u).filter((line) => line.startsWith("data: "));
    if (data.length === 0) continue;
    if (data.length !== 1 || events.length >= 512) throw new Error("AI_STREAM_INVALID");
    const event = AiStreamEventSchema.parse(JSON.parse(data[0]!.slice(6)));
    if (event.cursor <= cursor) throw new Error("AI_STREAM_INVALID");
    cursor = event.cursor;
    events.push(event);
  }
  return { ok: true, data: { events, cursor } };
}

/** One finite domain operation; the renderer cannot select URLs, headers, or bearer credentials. */
export function createDesktopAiOperation(
  dependencies: Pick<DesktopHttpTransportDependencies, "request">,
  currentState: () => AuthState | null,
  refreshIfNeeded: (expected: AuthState) => Promise<void> = async () => undefined,
) {
  const streams = new Map<string, AbortController>();
  const cancelAll = () => {
    for (const abort of streams.values()) abort.abort();
    streams.clear();
  };
  return Object.freeze({
    cancelAll,
    async execute(raw: unknown): Promise<unknown> {
      const parsed = DesktopAiInputSchema.safeParse(raw);
      if (!parsed.success) return VALIDATION_FAILURE;
      const input = parsed.data;
      const initial = currentState();
      if (initial === null) return AUTHENTICATION_FAILURE;
      if (input.operation === "cancel") {
        streams.get(input.session_id)?.abort();
        streams.delete(input.session_id);
        return { ok: true, data: { cancelled: true } };
      }
      const selected = route(input);
      if (selected === null) return VALIDATION_FAILURE;
      const abort = new AbortController();
      if (input.operation === "stream") {
        if (streams.has(input.session_id)) return RESOURCE_FAILURE;
        streams.set(input.session_id, abort);
      }
      try {
        await refreshIfNeeded(initial);
        const state = currentState();
        if (abort.signal.aborted || state === null || !isSameSession(initial, state))
          return RESOURCE_FAILURE;
        const request = createDesktopRequest(selected.method, selected.path, {
          accessToken: state.accessToken,
          ...(selected.method === "POST" ? { csrfToken: state.csrfToken } : {}),
          ...(selected.body === undefined ? {} : { body: selected.body }),
        });
        const response = await dependencies.request({
          ...request,
          signal: abort.signal,
          ...(input.operation === "stream"
            ? { headers: { ...request.headers, "Last-Event-ID": String(input.after) } }
            : {}),
        });
        const current = currentState();
        if (abort.signal.aborted || current === null || !isSameSession(state, current))
          return RESOURCE_FAILURE;
        const result =
          input.operation === "stream" && response.statusCode === 200
            ? streamResult(response.bodyText, input.after)
            : JSON.parse(response.bodyText);
        const bounded = DesktopAiResultSchema.safeParse(result);
        return bounded.success &&
          ((response.statusCode >= 200 && response.statusCode < 300) || !bounded.data.ok)
          ? bounded.data
          : RESOURCE_FAILURE;
      } catch {
        return RESOURCE_FAILURE;
      } finally {
        if (input.operation === "stream" && streams.get(input.session_id) === abort)
          streams.delete(input.session_id);
      }
    },
  });
}
