import {
  AiSafetyStatusResponseSchema,
  AiSessionCreateResponseSchema,
  AiTurnCreateResponseSchema,
  DesktopAiStreamResponseSchema,
} from "@laundry/contracts";
import type { AiPanelPort } from "../host/ai-port.js";
import type { AiOperationPort } from "./settings-port.js";

const unavailable = () => ({
  ok: false as const,
  error: {
    code: "UNAVAILABLE" as const,
    message: "AI 尚未配置或暂时不可用，请检查本机配置与网络。",
  },
});

export function createDesktopAiPanelPort(operation: AiOperationPort): AiPanelPort {
  return Object.freeze({
    async getSafetyStatus() {
      try {
        const result = AiSafetyStatusResponseSchema.safeParse(
          await operation({ operation: "safety" }),
        );
        return result.success ? { ok: true, data: result.data.data } : unavailable();
      } catch {
        return unavailable();
      }
    },
    async createSession() {
      try {
        const result = AiSessionCreateResponseSchema.safeParse(
          await operation({ operation: "session" }),
        );
        return result.success
          ? { ok: true, data: { sessionId: result.data.data.session_id } }
          : unavailable();
      } catch {
        return unavailable();
      }
    },
    async createTurn(sessionId, input) {
      try {
        const result = AiTurnCreateResponseSchema.safeParse(
          await operation({
            operation: "turn",
            session_id: sessionId,
            body: {
              prompt: input.prompt,
              idempotency_key: input.idempotencyKey,
              max_output_tokens: 1024,
            },
          }),
        );
        return result.success
          ? {
              ok: true,
              data: { turnId: result.data.data.turn_id, replayed: result.data.data.replayed },
            }
          : unavailable();
      } catch {
        return unavailable();
      }
    },
    async stream(sessionId, after, signal, onEvent) {
      const cancel = () => {
        void operation({ operation: "cancel", session_id: sessionId }).catch(() => undefined);
      };
      if (signal.aborted) return unavailable();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const result = DesktopAiStreamResponseSchema.safeParse(
          await operation({ operation: "stream", session_id: sessionId, after }),
        );
        if (signal.aborted || !result.success) return unavailable();
        for (const event of result.data.data.events) {
          if (signal.aborted) return unavailable();
          onEvent(event);
        }
        return { ok: true, data: { cursor: result.data.data.cursor } };
      } catch {
        return unavailable();
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
  });
}
