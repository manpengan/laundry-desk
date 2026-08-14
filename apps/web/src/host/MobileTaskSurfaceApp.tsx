import { MobileTaskShell } from "../mobile/MobileTaskShell.js";
import { mobileTaskSessionScope } from "../mobile/mobile-task-request-authority.js";
import { StaffSurfaceRoot } from "./StaffSurfaceRoot.js";
import type { StaffSurfaceAppProps } from "./staff-surface-types.js";

export function MobileTaskSurfaceApp({
  ports,
  enableLiquidGlass,
  initialSession,
}: StaffSurfaceAppProps) {
  return (
    <StaffSurfaceRoot
      auth={ports.auth}
      loginTitle="配送任务登录"
      loginHint="使用当前门店员工账号进入我的任务"
      {...(enableLiquidGlass === undefined ? {} : { enableLiquidGlass })}
      {...(initialSession === undefined ? {} : { initialSession })}
      renderAuthenticated={({ session, onSessionChange }) => (
        <MobileTaskShell
          key={mobileTaskSessionScope(session)}
          session={session}
          authClient={ports.auth}
          commandClient={ports.command}
          queryClient={ports.query}
          {...(ports.deliveryEvidence === undefined ? {} : { mediaPort: ports.deliveryEvidence })}
          onSessionChange={onSessionChange}
        />
      )}
    />
  );
}
