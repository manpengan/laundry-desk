import {
  DesktopReceiveRecoveryInputSchema,
  DesktopReceiveRecoveryResultSchema,
  type DesktopCommandExecuteResult,
  type DesktopReceiveRecoveryResult,
  type ReceiveRecoverySession,
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

/** Queues one receive body under the given idempotency key; the offline runtime owns it. */
export type OfflineReceiveQueue = (
  body: Readonly<Record<string, unknown>>,
  idempotencyKey: string,
) => Promise<DesktopCommandExecuteResult>;

export function createReceiveRecoveryOperation(
  journal: ReceiveRecoveryJournal,
  currentState: () => AuthState | null,
  submit: (
    body: Readonly<Record<string, unknown>>,
    operationId: string,
  ) => Promise<DesktopCommandExecuteResult>,
) {
  /**
   * The journal belongs to one employee's session. An expired access token is not a change
   * of employee: the submit path refreshes it, and saving or reading the encrypted local
   * record never needs the server.
   */
  const sessionFor = (expected: ReceiveRecoverySession): AuthState | null => {
    const state = currentState();
    return state === null ||
      state.sessionView.session.session_id !== expected.session_id ||
      state.sessionView.session.session_version !== expected.session_version ||
      !["admin", "staff"].includes(state.sessionView.role)
      ? null
      : state;
  };
  return Object.freeze({
    async execute(raw: unknown): Promise<DesktopReceiveRecoveryResult> {
      const input = DesktopReceiveRecoveryInputSchema.safeParse(raw);
      if (!input.success) return failure("RECOVERY_CONFLICT", "恢复请求格式无效，开单已暂停");
      const expected = input.data.expected_session;
      const state = sessionFor(expected);
      if (state === null) {
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

    /**
     * Hands a submitted receive to the offline queue while the local service is down. A
     * receive that was already sent keeps its original key, so a replay after a lost commit
     * returns that order; one never sent gets its first key here. Returns null when the
     * input is not such a receive, its outcome is known, or the queue refuses it.
     */
    async queueOffline(
      raw: unknown,
      queue: OfflineReceiveQueue,
    ): Promise<DesktopReceiveRecoveryResult | null> {
      const input = DesktopReceiveRecoveryInputSchema.safeParse(raw);
      if (!input.success || input.data.operation !== "submit") return null;
      const state = sessionFor(input.data.expected_session);
      if (state === null) return null;
      const id = input.data.operation_id;
      const body = JSON.stringify(input.data.body);
      try {
        if (journal.load(state.sessionView).draft?.operationId !== id) return null;
        const pending =
          journal.unconfirmed(state.sessionView, id) ??
          (journal.hasOperation(state.sessionView, id)
            ? null
            : journal.prepare(state.sessionView, id, body));
        if (pending === null || pending.body !== body) return null;
        const queued = await queue(input.data.body, pending.key);
        if (!queued.ok) return null;
        journal.recordQueued(state.sessionView, id, queued);
        return DesktopReceiveRecoveryResultSchema.parse({
          ok: true,
          data: journal.load(state.sessionView),
        });
      } catch {
        return null;
      }
    },
  });
}
