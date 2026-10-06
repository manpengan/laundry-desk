import {
  DesktopReceiveRecoveryInputSchema,
  DesktopReceiveRecoveryResultSchema,
  type DesktopReceiveRecoveryInput,
  type DesktopReceiveRecoveryResult,
} from "@laundry/contracts";

export type ReceiveRecoveryPort = Readonly<{
  execute: (input: DesktopReceiveRecoveryInput) => Promise<DesktopReceiveRecoveryResult>;
}>;
export function createReceiveRecoveryPort(
  invoke: (input: unknown) => Promise<unknown>,
): ReceiveRecoveryPort {
  return Object.freeze({
    async execute(input: DesktopReceiveRecoveryInput): Promise<DesktopReceiveRecoveryResult> {
      try {
        const parsed = DesktopReceiveRecoveryInputSchema.parse(input);
        return DesktopReceiveRecoveryResultSchema.parse(await invoke(parsed));
      } catch {
        return {
          ok: false,
          error: {
            code: "RECOVERY_UNAVAILABLE",
            message: "桌面恢复服务不可用，已暂停开单；请保留当前内容并检查服务",
          },
        };
      }
    },
  });
}
