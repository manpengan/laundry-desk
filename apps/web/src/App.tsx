import { installLiquidGlass, ToastProvider } from "@laundry/ui";
import { useEffect, useMemo, useState } from "react";
import { createMockAuthClient, type AuthClient } from "./auth/AuthClient.js";
import type { AccessSession, LoginFormValues } from "./auth/types.js";
import type { ConnectionStatus } from "./connection.js";
import { LoginPage } from "./pages/LoginPage.js";
import { CounterShell, type CounterShellProps } from "./shell/CounterShell.js";
import type { ThemePreference } from "./theme.js";

export type AppProps = {
  connection?: ConnectionStatus;
  themePreference?: ThemePreference;
  /** Skip liquid-glass install in pure SSR unit tests. */
  enableLiquidGlass?: boolean;
  /** Injectable auth port (defaults to mock). */
  authClient?: AuthClient;
  /** Seed session for tests / host bootstrap; memory only. */
  initialSession?: AccessSession | null;
  /** Local host demo prefill only. */
  loginInitialForm?: Partial<LoginFormValues>;
  /** Local server origin for command bus (settings R5 demo). */
  apiBaseUrl?: string;
};

function shellPropsFrom(
  connection: ConnectionStatus | undefined,
  themePreference: ThemePreference | undefined,
  session: AccessSession,
  authClient: AuthClient,
  onSessionChange: (session: AccessSession | null) => void,
  apiBaseUrl: string | undefined,
): CounterShellProps {
  const props: CounterShellProps = {
    session,
    authClient,
    onSessionChange,
  };
  if (connection !== undefined) props.initialConnection = connection;
  if (themePreference !== undefined) props.initialTheme = themePreference;
  if (apiBaseUrl !== undefined && apiBaseUrl.length > 0) props.apiBaseUrl = apiBaseUrl;
  return props;
}

/**
 * Web app root: unauthenticated → LoginPage; authenticated → CounterShell.
 * Access session is React state only (never localStorage/sessionStorage).
 */
export function App({
  connection,
  themePreference,
  enableLiquidGlass = true,
  authClient: authClientProp,
  initialSession = null,
  loginInitialForm,
  apiBaseUrl,
}: AppProps) {
  const authClient = useMemo(() => authClientProp ?? createMockAuthClient(), [authClientProp]);
  const [session, setSession] = useState<AccessSession | null>(initialSession);

  useEffect(() => {
    if (enableLiquidGlass && typeof document !== "undefined") {
      installLiquidGlass();
    }
  }, [enableLiquidGlass]);

  return (
    <ToastProvider>
      {session ? (
        <CounterShell
          {...shellPropsFrom(
            connection,
            themePreference,
            session,
            authClient,
            setSession,
            apiBaseUrl,
          )}
        />
      ) : (
        <LoginPage
          authClient={authClient}
          onSuccess={setSession}
          {...(loginInitialForm !== undefined ? { initialForm: loginInitialForm } : {})}
        />
      )}
    </ToastProvider>
  );
}
