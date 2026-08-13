import { useEffect, useMemo, useState } from "react";
import type { PrintJobSummary } from "@laundry/ui";
import type { AuthClient } from "../auth/AuthClient.js";
import { filterNavItems, permissionContextFrom } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import type { PhotoPort } from "../host/photo-port.js";
import type { OfflinePort } from "../host/offline-port.js";
import type { PrinterPort } from "../host/printer-port.js";
import type { AiPanelPort } from "../host/ai-port.js";
import { createMockConnection, type ConnectionStatus } from "../connection.js";
import type { NavItemId } from "../nav.js";
import { PageHost } from "../pages/PageHost.js";
import { RouteGate } from "../routing/RouteGate.js";
import {
  applyThemeToDocument,
  cycleThemePreference,
  resolveTheme,
  type ThemePreference,
} from "../theme.js";
import { PinSwitchDialog } from "./PinSwitchDialog.js";
import { PrintQueuePanel } from "./PrintQueuePanel.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";
import { usePrintJobSummary } from "./use-print-job-summary.js";
import { AiPanel } from "./AiPanel.js";

export type CounterShellProps = {
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  queryClient: QueryPort;
  photoPort?: PhotoPort;
  offlinePort?: OfflinePort;
  printerPort?: PrinterPort;
  aiPort?: AiPanelPort;
  onSessionChange: (session: SessionView | null) => void;
  initialConnection?: ConnectionStatus;
  initialTheme?: ThemePreference;
  initialNav?: NavItemId;
  systemDark?: boolean;
  documentRef?: Pick<Document, "documentElement"> | null;
  /**
   * When set, indicator uses this fixed summary (tests).
   * When omitted, shell polls print.jobs.list via queryClient.
   */
  printSummary?: PrintJobSummary;
  /** Simulate first-paint skeleton once (ms). 0 = off. */
  initialLoadingMs?: number;
  readOnly?: boolean;
};

const READ_ONLY_COMMAND_PORT: CommandPort = Object.freeze({
  execute: async <T,>(): Promise<
    Readonly<
      { ok: true; data: T } | { ok: false; error: Readonly<{ code: string; message: string }> }
    >
  > =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({
        code: "OFFLINE_READ_ONLY",
        message: "当前为离线只读模式，不能执行写操作",
      }),
    }),
});

function readSystemDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function connectionFromSession(
  session: SessionView,
  initial: ConnectionStatus | undefined,
): ConnectionStatus {
  const base = initial ?? createMockConnection();
  return {
    ...base,
    storeName: session.display.store_name,
    staffName: session.display.staff_name,
  };
}

export function CounterShell({
  session,
  authClient,
  onSessionChange,
  initialConnection,
  initialTheme = "system",
  initialNav = "workbench",
  systemDark,
  documentRef = null,
  printSummary: printSummaryProp,
  initialLoadingMs = 0,
  commandClient,
  queryClient,
  photoPort,
  offlinePort,
  printerPort,
  aiPort,
  readOnly = false,
}: CounterShellProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeId, setActiveId] = useState<NavItemId>(initialNav);
  const [themePref, setThemePref] = useState<ThemePreference>(initialTheme);
  const [loading, setLoading] = useState(initialLoadingMs > 0);
  const [pinOpen, setPinOpen] = useState(false);
  const [printQueueOpen, setPrintQueueOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const connection = useMemo(
    () => connectionFromSession(session, initialConnection),
    [session, initialConnection],
  );
  const dark = systemDark ?? readSystemDark();

  const printSummary = usePrintJobSummary(
    queryClient,
    readOnly ? Object.freeze({ queued: 0, failed: 0 }) : printSummaryProp,
  );
  const effectiveCommandClient = readOnly ? READ_ONLY_COMMAND_PORT : commandClient;

  // UI gate only; C8 enforces.
  const permission = useMemo(
    () => permissionContextFrom(session.role, session.features),
    [session.role, session.features],
  );
  const navItems = useMemo(() => filterNavItems(permission), [permission]);

  useEffect(() => {
    const doc = documentRef ?? (typeof document !== "undefined" ? document : null);
    if (!doc) return;
    applyThemeToDocument(doc, resolveTheme(themePref, dark));
  }, [themePref, dark, documentRef]);

  useEffect(() => {
    if (initialLoadingMs <= 0) return;
    const t = setTimeout(() => setLoading(false), initialLoadingMs);
    return () => clearTimeout(t);
  }, [initialLoadingMs]);

  return (
    <div
      className="ld-shell"
      data-shell="counter"
      data-nav={activeId}
      data-role={session.role}
      data-read-only={readOnly ? "true" : "false"}
    >
      <a className="ld-skip-link" href="#main-content">
        跳到主内容
      </a>
      <Sidebar
        expanded={expanded}
        activeId={activeId}
        onSelect={setActiveId}
        onToggleExpand={() => setExpanded((v) => !v)}
        items={navItems}
      />
      <div className="ld-shell-body">
        <TopBar
          connection={connection}
          themePreference={themePref}
          onCycleTheme={() => setThemePref((p) => cycleThemePreference(p))}
          printSummary={printSummary}
          onOpenPrintQueue={() => setPrintQueueOpen(true)}
          {...(readOnly || aiPort === undefined ? {} : { onOpenAi: () => setAiOpen(true) })}
          {...(readOnly ? {} : { onSwitchStaff: () => setPinOpen(true) })}
          readOnly={readOnly}
        />
        {readOnly ? (
          <div className="ld-offline-read-only" role="status">
            离线只读：当前显示本机加密缓存，不能开单、收款、取衣或修改资料。
          </div>
        ) : null}
        <RouteGate permission={permission} activeId={activeId} onNavigate={setActiveId}>
          <PageHost
            activeId={activeId}
            loading={loading}
            onNavigate={setActiveId}
            session={session}
            authClient={authClient}
            commandClient={effectiveCommandClient}
            queryClient={queryClient}
            onSessionChange={onSessionChange}
            {...(offlinePort === undefined ? {} : { offlinePort })}
            {...(printerPort === undefined || readOnly ? {} : { printerPort })}
            {...(photoPort === undefined || readOnly ? {} : { photoPort })}
          />
        </RouteGate>
      </div>
      <PinSwitchDialog
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        authClient={authClient}
        currentStaffId={session.session.staff_id}
        onSwitched={(next) => {
          onSessionChange(next);
          setPinOpen(false);
        }}
      />
      <PrintQueuePanel
        open={printQueueOpen}
        onClose={() => setPrintQueueOpen(false)}
        queryClient={queryClient}
        commandClient={effectiveCommandClient}
      />
      {aiPort === undefined ? null : (
        <AiPanel
          open={aiOpen}
          onClose={() => setAiOpen(false)}
          authSessionId={session.session.session_id}
          aiPort={aiPort}
        />
      )}
    </div>
  );
}
