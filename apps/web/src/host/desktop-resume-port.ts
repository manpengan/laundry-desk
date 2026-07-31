import type { SessionView } from "../auth/types.js";
import type { LaundryDesktopBridge } from "./desktop-bridge.js";
import { readDesktopSessionView } from "./desktop-session-view.js";

export type HostResumeResult =
  | Readonly<{
      ok: true;
      session: SessionView;
      mode: "online" | "offline_read_only";
    }>
  | Readonly<{ ok: false }>;

export type ResumePort = Readonly<{
  resume: () => Promise<HostResumeResult>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function parseResume(value: unknown): HostResumeResult {
  if (!isRecord(value) || value.ok !== true || !hasExactKeys(value, ["ok", "data"])) {
    return Object.freeze({ ok: false });
  }
  const data = value.data;
  if (!isRecord(data)) return Object.freeze({ ok: false });
  if (data.mode === "online" && hasExactKeys(data, ["mode", "session_view"])) {
    const session = readDesktopSessionView(data.session_view);
    return session === null
      ? Object.freeze({ ok: false })
      : Object.freeze({ ok: true, session, mode: "online" });
  }
  if (
    data.mode === "offline_read_only" &&
    hasExactKeys(data, ["mode", "session_view", "cached_query_count", "grant_not_after"]) &&
    typeof data.cached_query_count === "number" &&
    Number.isSafeInteger(data.cached_query_count) &&
    data.cached_query_count > 0 &&
    data.cached_query_count <= 128 &&
    typeof data.grant_not_after === "string" &&
    Number.isFinite(Date.parse(data.grant_not_after)) &&
    new Date(Date.parse(data.grant_not_after)).toISOString() === data.grant_not_after
  ) {
    const session = readDesktopSessionView(data.session_view);
    return session === null
      ? Object.freeze({ ok: false })
      : Object.freeze({ ok: true, session, mode: "offline_read_only" });
  }
  return Object.freeze({ ok: false });
}

export function createDesktopResumePort(
  offline: LaundryDesktopBridge["offline"],
): ResumePort | undefined {
  if (offline === undefined) return undefined;
  return Object.freeze({
    resume: async () => {
      try {
        return parseResume(await offline.resume());
      } catch {
        return Object.freeze({ ok: false });
      }
    },
  });
}
