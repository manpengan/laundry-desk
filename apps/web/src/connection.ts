/**
 * Connection strip model for SyncStatusBar.
 * Store/staff labels come from memory AccessSession after E1 login;
 * mode/pending still mock until Edge bridge heartbeat lands.
 */

export type ConnectionMode = "online" | "offline" | "degraded";

export type ConnectionStatus = {
  mode: ConnectionMode;
  pendingSyncCount: number;
  /** Human store label for top bar (mock until C6/E1). */
  storeName: string;
  staffName: string;
};

export function createMockConnection(overrides: Partial<ConnectionStatus> = {}): ConnectionStatus {
  return {
    mode: "online",
    pendingSyncCount: 0,
    storeName: "演示门店",
    staffName: "店员",
    ...overrides,
  };
}

export function connectionModeLabel(mode: ConnectionMode): string {
  if (mode === "online") return "在线";
  if (mode === "offline") return "离线";
  return "降级";
}

/** e.g. "在线 · 0 笔待同步" / "离线 · 3 笔待同步" */
export function formatConnectionStrip(status: ConnectionStatus): string {
  const mode = connectionModeLabel(status.mode);
  const n = status.pendingSyncCount;
  const pending = n <= 0 ? "0 笔待同步" : `${n} 笔待同步`;
  return `${mode} · ${pending}`;
}

export function connectionTone(status: ConnectionStatus): "ok" | "warn" | "danger" {
  if (status.mode === "online" && status.pendingSyncCount === 0) return "ok";
  if (status.mode === "offline") return "danger";
  return "warn";
}
