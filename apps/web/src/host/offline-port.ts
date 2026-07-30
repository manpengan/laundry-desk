export type OfflineConflictView = Readonly<{
  queueId: string;
  command: string;
  errorCode: string;
  createdAt: string;
}>;

export type OfflineStatusView = Readonly<{
  pendingCount: number;
  inflightCount: number;
  conflicts: readonly OfflineConflictView[];
}>;

export type OfflineStatusResult =
  | Readonly<{ ok: true; data: OfflineStatusView }>
  | Readonly<{ ok: false; error: Readonly<{ code: "SERVICE_UNAVAILABLE"; message: string }> }>;

export type OfflinePort = Readonly<{
  status: () => Promise<OfflineStatusResult>;
  resolve: (queueId: string, action: "retry" | "discard") => Promise<OfflineStatusResult>;
}>;

type OfflineBridge = Readonly<{
  status: () => Promise<unknown>;
  resolve: (input: Readonly<{ queue_id: string; action: "retry" | "discard" }>) => Promise<unknown>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): OfflineStatusResult {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: "SERVICE_UNAVAILABLE",
      message: "离线队列状态不可用",
    }),
  });
}

function parseResult(value: unknown): OfflineStatusResult {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.data)) return unavailable();
  const data = value.data;
  if (
    !Number.isSafeInteger(data.pending_count) ||
    Number(data.pending_count) < 0 ||
    !Number.isSafeInteger(data.inflight_count) ||
    Number(data.inflight_count) < 0 ||
    !Array.isArray(data.conflicts) ||
    data.conflicts.length > 1_000
  ) {
    return unavailable();
  }
  const conflicts: OfflineConflictView[] = [];
  for (const entry of data.conflicts) {
    if (
      !isRecord(entry) ||
      typeof entry.queue_id !== "string" ||
      !UUID.test(entry.queue_id) ||
      typeof entry.command !== "string" ||
      typeof entry.error_code !== "string" ||
      !ERROR_CODE.test(entry.error_code) ||
      typeof entry.created_at !== "string" ||
      !Number.isFinite(Date.parse(entry.created_at))
    ) {
      return unavailable();
    }
    conflicts.push(
      Object.freeze({
        queueId: entry.queue_id,
        command: entry.command,
        errorCode: entry.error_code,
        createdAt: entry.created_at,
      }),
    );
  }
  return Object.freeze({
    ok: true,
    data: Object.freeze({
      pendingCount: Number(data.pending_count),
      inflightCount: Number(data.inflight_count),
      conflicts: Object.freeze(conflicts),
    }),
  });
}

export function createDesktopOfflinePort(bridge: OfflineBridge | undefined): OfflinePort {
  return Object.freeze({
    status: async () => {
      if (bridge === undefined) return unavailable();
      try {
        return parseResult(await bridge.status());
      } catch {
        return unavailable();
      }
    },
    resolve: async (queueId, action) => {
      if (bridge === undefined || !UUID.test(queueId)) return unavailable();
      try {
        return parseResult(await bridge.resolve(Object.freeze({ queue_id: queueId, action })));
      } catch {
        return unavailable();
      }
    },
  });
}
