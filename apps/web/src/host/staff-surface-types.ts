import type { LoginWorkspace } from "../auth/login-memory.js";
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
  /** Host-bound 机构 / 门店代码 (desktop); login then asks only for the staff account. */
  loginWorkspace?: LoginWorkspace;
}>;
