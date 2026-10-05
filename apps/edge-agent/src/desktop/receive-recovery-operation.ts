import {
  DesktopReceiveRecoveryInputSchema,
  DesktopReceiveRecoveryResultSchema,
  type DesktopCommandExecuteResult,
  type DesktopReceiveRecoveryResult,
} from "@laundry/contracts";
import {
  ReceiveRecoveryConflict,
  type ReceiveRecoveryJournal,
} from "./receive-recovery-journal.js";
import { isSameSession, type AuthState } from "./http-transport-support.js";

export const DESKTOP_RECEIVE_RECOVERY_OPERATION = Object.freeze({
  input: DesktopReceiveRecoveryInputSchema,
  result: DesktopReceiveRecoveryResultSchema,
});
const failure = (
  code: "RECOVERY_UNAVAILABLE" | "RECOVERY_CONFLICT" | "AUTHENTICATION_FAILED",
  message: string,
): DesktopReceiveRecoveryResult => ({ ok: false, error: { code, message } });

export function createReceiveRecoveryOperation(
  journal: ReceiveRecoveryJournal,
  currentState: () => AuthState | null,
  submit: (
    body: Readonly<Record<string, unknown>>,
    operationId: string,
  ) => Promise<DesktopCommandExecuteResult>,
  now: () => number = Date.now,
) {
  return Object.freeze({
    async execute(raw: unknown): Promise<DesktopReceiveRecoveryResult> {
      const input = DesktopReceiveRecoveryInputSchema.safeParse(raw);
      if (!input.success) return failure("RECOVERY_CONFLICT", "恢复请求格式无效，开单已暂停");
      const state = currentState();
      const expected = input.data.expected_session;
      if (
        state === null ||
        state.expiresAtMs <= now() ||
        state.sessionView.session.session_id !== expected.session_id ||
        state.sessionView.session.session_version !== expected.session_version ||
        !["admin", "staff"].includes(state.sessionView.role)
      ) {
        return failure("AUTHENTICATION_FAILED", "登录身份已变化，请重新登录后恢复本人的开单");
      }
      try {
        if (input.data.operation === "save") journal.save(state.sessionView, input.data.draft);
        if (input.data.operation === "submit") {
          if (journal.load(state.sessionView).draft?.operationId !== input.data.operation_id)
            throw new ReceiveRecoveryConflict("恢复记录已变化，请重新加载当前开单");
          const result = await submit(input.data.body, input.data.operation_id);
          const current = currentState();
          if (
            current === null ||
            !isSameSession(state, current) ||
            current.sessionView.session.session_version !== expected.session_version
          )
            return failure("AUTHENTICATION_FAILED", "登录身份已变化，结果已保留在原员工恢复记录中");
          const snapshot = journal.load(state.sessionView);
          // A missing durable receipt includes a lost response or a failed receipt write.
          // Do not return even a known success until the receipt is durably recorded.
          if (snapshot.receipt === null)
            return failure(
              "RECOVERY_UNAVAILABLE",
              "本次开单结果未确认，请使用原开单重试；不要再次收款",
            );
          if (!result.ok && snapshot.receipt.ok) {
            return failure("RECOVERY_UNAVAILABLE", "原开单结果已保留，请恢复后核对订单");
          }
        }
        return DesktopReceiveRecoveryResultSchema.parse({
          ok: true,
          data: journal.load(state.sessionView),
        });
      } catch (error) {
        return error instanceof ReceiveRecoveryConflict
          ? failure("RECOVERY_CONFLICT", error.message)
          : failure(
              "RECOVERY_UNAVAILABLE",
              "本机开单恢复记录无法安全读写，已暂停开单；请检查磁盘或联系管理员",
            );
      }
    },
  });
}
