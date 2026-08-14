import { LazyCounterShell } from "../shell/LazyCounterShell.js";
import { StaffSurfaceRoot } from "./StaffSurfaceRoot.js";
import { shellPropsFrom } from "./surface-props.js";
import type { StaffSurfaceAppProps } from "./staff-surface-types.js";

export function CounterSurfaceApp({
  ports,
  connection,
  themePreference,
  enableLiquidGlass,
  initialSession,
  readOnly = false,
}: StaffSurfaceAppProps) {
  return (
    <StaffSurfaceRoot
      auth={ports.auth}
      {...(enableLiquidGlass === undefined ? {} : { enableLiquidGlass })}
      {...(initialSession === undefined ? {} : { initialSession })}
      renderAuthenticated={({ session, onSessionChange }) => (
        <LazyCounterShell
          {...shellPropsFrom(
            connection,
            themePreference,
            session,
            ports,
            onSessionChange,
            readOnly,
          )}
        />
      )}
    />
  );
}
