import type { SessionView } from "../auth/types.js";
import type { ConnectionStatus } from "../connection.js";
import type { ThemePreference } from "../theme.js";
import type { AppPorts } from "./types.js";

export type StaffSurfaceAppProps = Readonly<{
  ports: AppPorts;
  connection?: ConnectionStatus;
  themePreference?: ThemePreference;
  enableLiquidGlass?: boolean;
  initialSession?: SessionView | null;
  readOnly?: boolean;
}>;
