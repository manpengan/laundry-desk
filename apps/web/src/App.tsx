import { installLiquidGlass, ToastProvider } from "@laundry/ui";
import { useEffect, useState } from "react";
import type { SessionView, LoginFormValues } from "./auth/types.js";
import type { ConnectionStatus } from "./connection.js";
import type { AppPorts } from "./host/types.js";
import { LoginPage } from "./pages/LoginPage.js";
import { CounterShell, type CounterShellProps } from "./shell/CounterShell.js";
import type { ThemePreference } from "./theme.js";

export type AppProps = {
  ports: AppPorts;
  connection?: ConnectionStatus;
  themePreference?: ThemePreference;
  /** Skip liquid-glass install in pure SSR unit tests. */
  enableLiquidGlass?: boolean;
  /** Seed token-free session view for tests only. Production hosts start logged out. */
  initialSession?: SessionView | null;
  /** Local host demo prefill only. */
  loginInitialForm?: Partial<LoginFormValues>;
};

export function shellPropsFrom(
  connection: ConnectionStatus | undefined,
  themePreference: ThemePreference | undefined,
  session: SessionView,
  ports: AppPorts,
  onSessionChange: (session: SessionView | null) => void,
): CounterShellProps {
  const props: CounterShellProps = {
    session,
    authClient: ports.auth,
    commandClient: ports.command,
    queryClient: ports.query,
    photoPort: ports.photo,
    ...(ports.offline === undefined ? {} : { offlinePort: ports.offline }),
    onSessionChange,
  };
  if (connection !== undefined) props.initialConnection = connection;
  if (themePreference !== undefined) props.initialTheme = themePreference;
  return props;
}

/**
 * Web app root: unauthenticated → LoginPage; authenticated → CounterShell.
 * React state contains only SessionView; host adapters retain transport credentials.
 */
export function App({
  ports,
  connection,
  themePreference,
  enableLiquidGlass = true,
  initialSession = null,
  loginInitialForm,
}: AppProps) {
  const [session, setSession] = useState<SessionView | null>(initialSession);

  useEffect(() => {
    if (enableLiquidGlass && typeof document !== "undefined") {
      installLiquidGlass();
    }
  }, [enableLiquidGlass]);

  return (
    <ToastProvider>
      {session ? (
        <CounterShell
          {...shellPropsFrom(connection, themePreference, session, ports, setSession)}
        />
      ) : (
        <LoginPage
          authClient={ports.auth}
          onSuccess={setSession}
          {...(loginInitialForm !== undefined ? { initialForm: loginInitialForm } : {})}
        />
      )}
    </ToastProvider>
  );
}
