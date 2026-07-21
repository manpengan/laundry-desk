import { useEffect, useMemo, useState } from "react";
import type { PrintJobSummary } from "@laundry/ui";
import type { AuthClient } from "../auth/AuthClient.js";
import type { AccessSession } from "../auth/types.js";
import { createMockConnection, type ConnectionStatus } from "../connection.js";
import type { NavItemId } from "../nav.js";
import { PageHost } from "../pages/PageHost.js";
import {
  applyThemeToDocument,
  cycleThemePreference,
  resolveTheme,
  type ThemePreference,
} from "../theme.js";
import { PinSwitchDialog } from "./PinSwitchDialog.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";

export type CounterShellProps = {
  session: AccessSession;
  authClient: AuthClient;
  onSessionChange: (session: AccessSession | null) => void;
  initialConnection?: ConnectionStatus;
  initialTheme?: ThemePreference;
  initialNav?: NavItemId;
  systemDark?: boolean;
  documentRef?: Pick<Document, "documentElement"> | null;
  printSummary?: PrintJobSummary;
  /** Simulate first-paint skeleton once (ms). 0 = off. */
  initialLoadingMs?: number;
};

function readSystemDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function connectionFromSession(
  session: AccessSession,
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
  printSummary = { queued: 0, failed: 0 },
  initialLoadingMs = 0,
}: CounterShellProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeId, setActiveId] = useState<NavItemId>(initialNav);
  const [themePref, setThemePref] = useState<ThemePreference>(initialTheme);
  const [loading, setLoading] = useState(initialLoadingMs > 0);
  const [pinOpen, setPinOpen] = useState(false);
  const connection = useMemo(
    () => connectionFromSession(session, initialConnection),
    [session, initialConnection],
  );
  const dark = systemDark ?? readSystemDark();

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
    <div className="ld-shell" data-shell="counter" data-nav={activeId}>
      <a className="ld-skip-link" href="#main-content">
        跳到主内容
      </a>
      <Sidebar
        expanded={expanded}
        activeId={activeId}
        onSelect={setActiveId}
        onToggleExpand={() => setExpanded((v) => !v)}
      />
      <div className="ld-shell-body">
        <TopBar
          connection={connection}
          themePreference={themePref}
          onCycleTheme={() => setThemePref((p) => cycleThemePreference(p))}
          printSummary={printSummary}
          onSwitchStaff={() => setPinOpen(true)}
        />
        <PageHost activeId={activeId} loading={loading} onNavigate={setActiveId} />
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
    </div>
  );
}
