import {
  DesktopMaintenanceInputSchema,
  DesktopMaintenanceResultSchema,
  MaintenanceHealthSchema,
  MaintenanceOpenedSchema,
  type DesktopMaintenanceInput,
  type MaintenanceHealth,
} from "@laundry/contracts";
type Result<T> = Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string }>;
export type MaintenancePort = Readonly<{
  health: () => Promise<Result<MaintenanceHealth>>;
  open: (intent: "maintenance" | "backup" | "drill") => Promise<Result<true>>;
  handoff: (intent: "export-store" | "v1-import", requestId: string) => Promise<Result<true>>;
}>;
const failure = (): Result<never> => ({
  ok: false,
  error:
    "未能连接已绑定的 Windows 维护程序。请确认使用配套安装包、当前登录有效且没有其他维护正在进行，再重试。",
});
export function createMaintenancePort(
  operation: (input: DesktopMaintenanceInput) => Promise<unknown>,
): MaintenancePort {
  const execute = async (input: DesktopMaintenanceInput) => {
    try {
      const result = DesktopMaintenanceResultSchema.safeParse(
        await operation(DesktopMaintenanceInputSchema.parse(input)),
      );
      return result.success && result.data.ok ? result.data.data : null;
    } catch {
      return null;
    }
  };
  const opened = async (input: DesktopMaintenanceInput): Promise<Result<true>> =>
    MaintenanceOpenedSchema.safeParse(await execute(input)).success
      ? { ok: true, data: true }
      : failure();
  return {
    async health() {
      const result = MaintenanceHealthSchema.safeParse(await execute({ operation: "health" }));
      return result.success ? { ok: true, data: result.data } : failure();
    },
    open: (intent) => opened({ operation: "open", intent }),
    handoff: (intent, request_id) => opened({ operation: "handoff", intent, request_id }),
  };
}
