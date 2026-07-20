import { Button, StatusBadge } from "@laundry/ui";
import { connectionTone, formatConnectionStrip, type ConnectionStatus } from "../connection.js";
import { themePreferenceLabel, type ThemePreference } from "../theme.js";

export type TopBarProps = {
  connection: ConnectionStatus;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
};

function syncStatusKey(connection: ConnectionStatus): string {
  if (connection.mode === "offline") return "offline";
  if (connection.pendingSyncCount > 0) return "pending";
  return "online";
}

export function TopBar({ connection, themePreference, onCycleTheme }: TopBarProps) {
  const tone = connectionTone(connection);
  return (
    <header className="ld-shell-topbar">
      <div className="ld-shell-topbar__store">
        <strong>{connection.storeName}</strong>
        <span className="ld-shell-topbar__staff">{connection.staffName}</span>
      </div>
      <div className="ld-shell-topbar__status" data-tone={tone}>
        <StatusBadge family="sync" status={syncStatusKey(connection)} />
        <span>{formatConnectionStrip(connection)}</span>
      </div>
      <div className="ld-shell-topbar__actions">
        <Button variant="ghost" size="sm" type="button" onClick={onCycleTheme}>
          主题：{themePreferenceLabel(themePreference)}
        </Button>
      </div>
    </header>
  );
}
