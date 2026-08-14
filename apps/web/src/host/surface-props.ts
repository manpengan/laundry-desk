import type { SessionView } from "../auth/types.js";
import type { ConnectionStatus } from "../connection.js";
import type { OwnerShellProps } from "../owner/OwnerShell.js";
import type { CounterShellProps } from "../shell/CounterShellCore.js";
import type { ThemePreference } from "../theme.js";
import type { AppPorts } from "./types.js";

export function ownerShellPropsFrom(
  session: SessionView,
  ports: Pick<AppPorts, "auth" | "command" | "query" | "ai" | "approval">,
  onSessionChange: (session: SessionView | null) => void,
  onSelectStore?: OwnerShellProps["onSelectStore"],
): OwnerShellProps {
  const logout = async (): Promise<void> => {
    try {
      await ports.auth.logout();
    } catch {
      // A host failure must not retain the renderer session.
    } finally {
      onSessionChange(null);
    }
  };
  return Object.freeze({
    session,
    authClient: ports.auth,
    commandClient: ports.command,
    queryClient: ports.query,
    ...(ports.approval === undefined ? {} : { approvalPort: ports.approval }),
    onSessionChange,
    onSelectStore: onSelectStore ?? (async () => logout()),
    onLogout: logout,
    ...(ports.ai === undefined ? {} : { aiPort: ports.ai }),
  });
}

export function shellPropsFrom(
  connection: ConnectionStatus | undefined,
  themePreference: ThemePreference | undefined,
  session: SessionView,
  ports: AppPorts,
  onSessionChange: (session: SessionView | null) => void,
  readOnly = false,
): CounterShellProps {
  const props: CounterShellProps = {
    session,
    authClient: ports.auth,
    commandClient: ports.command,
    queryClient: ports.query,
    photoPort: ports.photo,
    ...(ports.ai === undefined ? {} : { aiPort: ports.ai }),
    ...(ports.offline === undefined ? {} : { offlinePort: ports.offline }),
    ...(ports.printer === undefined ? {} : { printerPort: ports.printer }),
    onSessionChange,
    readOnly,
  };
  if (connection !== undefined) props.initialConnection = connection;
  if (themePreference !== undefined) props.initialTheme = themePreference;
  return props;
}
