import { Button, PrintJobIndicator, SyncStatusBar, type PrintJobSummary } from "@laundry/ui";
import type { ConnectionStatus } from "../connection.js";
import { themePreferenceLabel, type ThemePreference } from "../theme.js";

export type TopBarProps = {
  connection: ConnectionStatus;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
  printSummary?: PrintJobSummary;
  onOpenPrintQueue?: () => void;
  /** Open PIN quick-switch when session is present. */
  onSwitchStaff?: () => void;
  aiOpen?: boolean;
  onToggleAi?: () => void;
  readOnly?: boolean;
};

export function TopBar({
  connection,
  themePreference,
  onCycleTheme,
  printSummary = { queued: 0, failed: 0 },
  onOpenPrintQueue,
  onSwitchStaff,
  aiOpen = false,
  onToggleAi,
  readOnly = false,
}: TopBarProps) {
  return (
    <header className="ld-shell-topbar" role="banner">
      <div className="ld-shell-topbar__store">
        <strong>{connection.storeName}</strong>
        <span className="ld-shell-topbar__staff">{connection.staffName}</span>
      </div>
      <div className="ld-shell-topbar__status">
        <SyncStatusBar mode={connection.mode} pendingSyncCount={connection.pendingSyncCount} />
      </div>
      <div className="ld-shell-topbar__actions">
        {readOnly ? <strong aria-label="离线只读">离线只读</strong> : null}
        {onSwitchStaff ? (
          <Button variant="secondary" size="sm" type="button" onClick={onSwitchStaff}>
            切换员工
          </Button>
        ) : null}
        {onToggleAi ? (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            aria-expanded={aiOpen}
            aria-controls="ld-ai-panel"
            onClick={onToggleAi}
          >
            ✨ AI
          </Button>
        ) : null}
        {onOpenPrintQueue ? (
          <PrintJobIndicator summary={printSummary} onOpen={onOpenPrintQueue} />
        ) : (
          <PrintJobIndicator summary={printSummary} />
        )}
        <Button variant="ghost" size="sm" type="button" onClick={onCycleTheme}>
          主题：{themePreferenceLabel(themePreference)}
        </Button>
      </div>
    </header>
  );
}
