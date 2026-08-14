import { OwnerShell } from "../owner/OwnerShell.js";
import { StaffSurfaceRoot } from "./StaffSurfaceRoot.js";
import { ownerShellPropsFrom } from "./surface-props.js";
import type { StaffSurfaceAppProps } from "./staff-surface-types.js";

export function OwnerSurfaceApp({
  ports,
  enableLiquidGlass,
  initialSession,
}: StaffSurfaceAppProps) {
  return (
    <StaffSurfaceRoot
      auth={ports.auth}
      loginTitle="店主登录"
      loginHint="使用管理员账号进入经营看板"
      {...(enableLiquidGlass === undefined ? {} : { enableLiquidGlass })}
      {...(initialSession === undefined ? {} : { initialSession })}
      renderAuthenticated={({ session, onSessionChange, setLoginInitialForm }) => (
        <OwnerShell
          {...ownerShellPropsFrom(session, ports, onSessionChange, async (selection) => {
            setLoginInitialForm(
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
              onSessionChange(null);
            }
          })}
        />
      )}
    />
  );
}
