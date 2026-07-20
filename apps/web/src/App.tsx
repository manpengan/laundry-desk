import { installLiquidGlass } from "@laundry/ui";
import { useEffect } from "react";
import type { ConnectionStatus } from "./connection.js";
import { CounterShell, type CounterShellProps } from "./shell/CounterShell.js";
import type { ThemePreference } from "./theme.js";

export type AppProps = {
  connection?: ConnectionStatus;
  themePreference?: ThemePreference;
  /** Skip liquid-glass install in pure SSR unit tests. */
  enableLiquidGlass?: boolean;
};

function shellPropsFrom(
  connection: ConnectionStatus | undefined,
  themePreference: ThemePreference | undefined,
): CounterShellProps {
  const props: CounterShellProps = {};
  if (connection !== undefined) props.initialConnection = connection;
  if (themePreference !== undefined) props.initialTheme = themePreference;
  return props;
}

/**
 * Web app root for counter shell (M1 skeleton).
 * Host must import styles: `@laundry/ui/styles.css`, `components.css`, and shell.css.
 */
export function App({ connection, themePreference, enableLiquidGlass = true }: AppProps) {
  useEffect(() => {
    if (enableLiquidGlass && typeof document !== "undefined") {
      installLiquidGlass();
    }
  }, [enableLiquidGlass]);

  return <CounterShell {...shellPropsFrom(connection, themePreference)} />;
}
