import { useEffect, useMemo, useState } from "react";
import { createMockConnection, type ConnectionStatus } from "../connection.js";
import type { NavItemId } from "../nav.js";
import {
  applyThemeToDocument,
  cycleThemePreference,
  resolveTheme,
  type ThemePreference,
} from "../theme.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";
import { WorkbenchPlaceholder } from "./WorkbenchPlaceholder.js";

export type CounterShellProps = {
  /** Inject for tests; default mock online strip. */
  initialConnection?: ConnectionStatus;
  initialTheme?: ThemePreference;
  /** Defaults to window.matchMedia dark query when available. */
  systemDark?: boolean;
  /** Defaults to global document when in browser. */
  documentRef?: Pick<Document, "documentElement"> | null;
};

function readSystemDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function CounterShell({
  initialConnection,
  initialTheme = "system",
  systemDark,
  documentRef = null,
}: CounterShellProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeId, setActiveId] = useState<NavItemId>("workbench");
  const [themePref, setThemePref] = useState<ThemePreference>(initialTheme);
  const connection = useMemo(
    () => initialConnection ?? createMockConnection(),
    [initialConnection],
  );
  const dark = systemDark ?? readSystemDark();

  useEffect(() => {
    const doc = documentRef ?? (typeof document !== "undefined" ? document : null);
    if (!doc) return;
    applyThemeToDocument(doc, resolveTheme(themePref, dark));
  }, [themePref, dark, documentRef]);

  const onCycleTheme = () => {
    setThemePref((prev) => cycleThemePreference(prev));
  };

  return (
    <div className="ld-shell" data-shell="counter">
      <Sidebar
        expanded={expanded}
        activeId={activeId}
        onSelect={setActiveId}
        onToggleExpand={() => setExpanded((v) => !v)}
      />
      <div className="ld-shell-body">
        <TopBar connection={connection} themePreference={themePref} onCycleTheme={onCycleTheme} />
        <WorkbenchPlaceholder activeId={activeId} />
      </div>
    </div>
  );
}
