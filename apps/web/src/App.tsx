import { installLiquidGlass, ToastProvider } from "@laundry/ui";
import { useEffect, useState } from "react";
import type { SessionView, LoginFormValues } from "./auth/types.js";
import type { ConnectionStatus } from "./connection.js";
import type { AppSurface } from "./host/app-surface.js";
import type { AppPorts } from "./host/types.js";
import { MobileTaskShell } from "./mobile/MobileTaskShell.js";
import { mobileTaskSessionScope } from "./mobile/mobile-task-request-authority.js";
import { OwnerShell, type OwnerShellProps } from "./owner/OwnerShell.js";
import { LoginPage } from "./pages/LoginPage.js";
import { CounterShell, type CounterShellProps } from "./shell/CounterShell.js";
import type { ThemePreference } from "./theme.js";

export type AppProps = {
  ports: AppPorts;
  /** Explicit product surface; desktop and legacy browser entry remain counter by default. */
  surface?: AppSurface;
  connection?: ConnectionStatus;
  themePreference?: ThemePreference;
  /** Skip liquid-glass install in pure SSR unit tests. */
  enableLiquidGlass?: boolean;
  /** Seed a token-free desktop or explicit mobile-task resume view. */
  initialSession?: SessionView | null;
  /** Desktop cold-start fallback is query-only; all mutation paths stay closed. */
  readOnly?: boolean;
  /** Local host demo prefill only. */
  loginInitialForm?: Partial<LoginFormValues>;
};

export function ownerShellPropsFrom(
  session: SessionView,
  ports: Pick<AppPorts, "auth" | "command" | "query" | "ai">,
  onSessionChange: (session: SessionView | null) => void,
  onSelectStore?: OwnerShellProps["onSelectStore"],
): OwnerShellProps {
  const logout = async (): Promise<void> => {
    try {
      await ports.auth.logout();
    } catch {
      // Logout is fail-closed for the renderer: a host failure must not retain the UI session.
    } finally {
      onSessionChange(null);
    }
  };
  return Object.freeze({
    session,
    authClient: ports.auth,
    commandClient: ports.command,
    queryClient: ports.query,
    onSessionChange,
    onSelectStore: onSelectStore ?? (async () => logout()),
    onLogout: logout,
    ...(ports.ai === undefined ? {} : { aiPort: ports.ai }),
  });
}

function loginPortFrom(auth: AppPorts["auth"]): Pick<AppPorts["auth"], "login"> {
  return Object.freeze({ login: (values: LoginFormValues) => auth.login(values) });
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

/**
 * Web app root: unauthenticated → LoginPage; authenticated → the exact selected shell.
 * React state contains only SessionView; host adapters retain transport credentials.
 */
export function App({
  ports,
  surface = "counter",
  connection,
  themePreference,
  enableLiquidGlass = true,
  initialSession = null,
  readOnly = false,
  loginInitialForm,
}: AppProps) {
  const [session, setSession] = useState<SessionView | null>(initialSession);
  const [activeLoginInitialForm, setActiveLoginInitialForm] = useState<
    Partial<LoginFormValues> | undefined
  >(loginInitialForm);

  useEffect(() => {
    if (enableLiquidGlass && typeof document !== "undefined") {
      installLiquidGlass();
    }
  }, [enableLiquidGlass]);

  return (
    <ToastProvider>
      {session ? (
        surface === "owner" ? (
          <OwnerShell
            {...ownerShellPropsFrom(session, ports, setSession, async (selection) => {
              setActiveLoginInitialForm(
                Object.freeze({
                  org_code: selection.orgCode,
                  store_code: selection.storeCode,
                  username: "",
                  password: "",
                }),
              );
              try {
                await ports.auth.logout();
              } finally {
                setSession(null);
              }
            })}
          />
        ) : surface === "mobile_delivery_tasks" ? (
          <MobileTaskShell
            key={mobileTaskSessionScope(session)}
            session={session}
            authClient={ports.auth}
            commandClient={ports.command}
            queryClient={ports.query}
            {...(ports.deliveryEvidence === undefined ? {} : { mediaPort: ports.deliveryEvidence })}
            onSessionChange={setSession}
          />
        ) : (
          <CounterShell
            {...shellPropsFrom(connection, themePreference, session, ports, setSession)}
            readOnly={readOnly}
          />
        )
      ) : (
        <LoginPage
          authClient={loginPortFrom(ports.auth)}
          onSuccess={setSession}
          {...(surface === "owner"
            ? { title: "店主登录", hint: "使用管理员账号进入经营看板" }
            : surface === "mobile_delivery_tasks"
              ? { title: "配送任务登录", hint: "使用当前门店员工账号进入我的任务" }
              : {})}
          {...(activeLoginInitialForm !== undefined ? { initialForm: activeLoginInitialForm } : {})}
        />
      )}
    </ToastProvider>
  );
}
