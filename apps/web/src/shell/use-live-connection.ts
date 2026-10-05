import { useEffect, useState } from "react";
import type { SessionView } from "../auth/types.js";
import { createMockConnection, type ConnectionStatus } from "../connection.js";
import type { HealthPort, HealthResult } from "../host/types.js";
import type { OfflinePort, OfflineStatusResult } from "../host/offline-port.js";

const POLL_MS = 5_000;
const TIMEOUT_MS = 4_000;

export function liveConnection(
  health: HealthResult | null,
  queue: OfflineStatusResult | null | undefined,
  readOnly: boolean,
): Pick<ConnectionStatus, "mode" | "pendingSyncCount" | "detail"> {
  const online = health?.ok === true && !readOnly;
  const known = queue?.ok === true;
  const pending = known ? queue.data.pendingCount + queue.data.inflightCount : null;
  const conflicts = known ? queue.data.conflicts.length : 0;
  const mode = !online
    ? "offline"
    : conflicts > 0 || (queue !== undefined && !known)
      ? "degraded"
      : "online";
  const detail = readOnly
    ? "离线只读，恢复连接后核对同步"
    : !online
      ? "本机服务未连接，操作结果需核对"
      : queue === undefined
        ? "本机服务已连接"
        : !known
          ? "同步状态未知"
          : conflicts > 0
            ? `${conflicts} 笔同步冲突待处理`
            : pending === 0
              ? "全部已同步"
              : `${pending} 笔待同步`;
  return Object.freeze({ mode, pendingSyncCount: pending, detail });
}

async function bounded<T>(read: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function useLiveConnection(
  session: SessionView,
  initial: ConnectionStatus | undefined,
  health: HealthPort | undefined,
  offline: OfflinePort | undefined,
  readOnly: boolean,
): ConnectionStatus {
  const [observed, setObserved] = useState<ReturnType<typeof liveConnection> | null>(null);
  useEffect(() => {
    if (health === undefined) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setObserved(null);
    const poll = async (): Promise<void> => {
      const [ready, queue] = await Promise.all([
        bounded(() => health.get()),
        offline === undefined ? undefined : bounded(() => offline.status()),
      ]);
      if (disposed) return;
      setObserved(liveConnection(ready, queue, readOnly));
      timer = setTimeout(() => {
        void poll();
      }, POLL_MS);
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [health, offline, readOnly, session.session.session_id, session.session.session_version]);
  const status =
    health === undefined
      ? (initial ?? createMockConnection())
      : readOnly
        ? liveConnection(null, null, true)
        : (observed ?? {
            mode: "degraded" as const,
            pendingSyncCount: null,
            detail: "正在检查本机服务…",
          });
  return {
    ...status,
    storeName: session.display.store_name,
    staffName: session.display.staff_name,
  };
}
