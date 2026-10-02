import {
  Button,
  Icon,
  Kbd,
  PrintJobIndicator,
  SyncStatusBar,
  type PrintJobSummary,
} from "@laundry/ui";
import type { ConnectionStatus } from "../connection.js";

export type TopBarProps = {
  connection: ConnectionStatus;
  printSummary?: PrintJobSummary;
  onOpenPrintQueue?: () => void;
  /** Open PIN quick-switch when session is present. */
  onSwitchStaff?: () => void;
  /** Ctrl+K command palette trigger. */
  onOpenCommand?: () => void;
  aiOpen?: boolean;
  onToggleAi?: () => void;
  readOnly?: boolean;
};

export function TopBar({
  connection,
  printSummary = { queued: 0, failed: 0 },
  onOpenPrintQueue,
  onSwitchStaff,
  onOpenCommand,
  aiOpen = false,
  onToggleAi,
  readOnly = false,
}: TopBarProps) {
  return (
    <header className="ld-shell-topbar" role="banner">
      <div className="ld-shell-topbar__store">
        <strong className="ld-shell-topbar__store-name">{connection.storeName}</strong>
        <span className="ld-shell-topbar__staff">{connection.staffName}</span>
      </div>
      {onOpenCommand === undefined ? null : (
        <button
          type="button"
          className="ld-shell-command"
          onClick={onOpenCommand}
          aria-keyshortcuts="Control+K"
          title="命令面板（Ctrl+K）"
        >
          <Icon name="search" size={18} />
          <span className="ld-shell-command__text">搜索功能、票号、手机号…</span>
          <span className="ld-shell-command__keys" aria-hidden="true">
            <Kbd>Ctrl</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
      )}
      <div className="ld-shell-topbar__status">
        <SyncStatusBar mode={connection.mode} pendingSyncCount={connection.pendingSyncCount} />
      </div>
      <div className="ld-shell-topbar__actions">
        {readOnly ? (
          <strong className="ld-shell-topbar__readonly" aria-label="离线只读">
            <Icon name="lock" size={16} />
            离线只读
          </strong>
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
        {onSwitchStaff ? (
          <Button variant="secondary" size="sm" type="button" onClick={onSwitchStaff}>
            <Icon name="switchUser" size={16} />
            切换员工
          </Button>
        ) : null}
      </div>
    </header>
  );
}
