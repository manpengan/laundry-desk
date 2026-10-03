import {
  AiVisionCandidatesResponseSchema,
  AiVisionResponseSchema,
  AiVisionRequestSchema,
  AiVisionCandidateQuerySchema,
  type AiVisionCandidate,
  type AiVisionRequest,
  type AiVisionResult,
} from "@laundry/contracts";
import type { AiOperationPort } from "./settings-port.js";
import type { HttpAiPanelPortOptions } from "../host/ai-port.js";

type Result<T> = Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: string }>;
export type VisionPort = Readonly<{
  candidates(key: string, signal: AbortSignal): Promise<Result<readonly AiVisionCandidate[]>>;
  analyze(input: AiVisionRequest, signal: AbortSignal): Promise<Result<AiVisionResult>>;
}>;
const failure = () => ({
  ok: false as const,
  error:
    "视觉辅助未完成。请检查网络、AI 图片模型、额度及照片权限；已开始但用量未知的调用会扣尽预留并暂停 AI，需管理员核查账单和配置。可先按原流程人工处理。",
});
export function createVisionPort(
  operation: (input: Parameters<AiOperationPort>[0], signal: AbortSignal) => Promise<unknown>,
): VisionPort {
  return Object.freeze({
    async candidates(key, signal) {
      try {
        const body = AiVisionCandidateQuerySchema.parse({ key });
        const result = AiVisionCandidatesResponseSchema.safeParse(
          await operation({ operation: "visionCandidates", body }, signal),
        );
        return result.success && !signal.aborted
          ? { ok: true, data: result.data.data.candidates }
          : failure();
      } catch {
        return failure();
      }
    },
    async analyze(input, signal) {
      try {
        const body = AiVisionRequestSchema.parse(input);
        const result = AiVisionResponseSchema.safeParse(
          await operation({ operation: "visionAnalyze", body }, signal),
        );
        return result.success && !signal.aborted ? { ok: true, data: result.data.data } : failure();
      } catch {
        return failure();
      }
    },
  });
}
export function createDesktopVisionPort(operation: AiOperationPort): VisionPort {
  return createVisionPort(async (input, signal) => {
    if (signal.aborted) return null;
    const cancel = () => {
      if (input.operation === "visionAnalyze")
        void operation({ operation: "cancel", session_id: input.body.request_id }).catch(
          () => undefined,
        );
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await operation(input);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  });
}
export function createHttpVisionPort(options: HttpAiPanelPortOptions): VisionPort {
  return createVisionPort(async (input, signal) => {
    if (input.operation !== "visionAnalyze" && input.operation !== "visionCandidates") return null;
    const token = options.getAccessToken();
    const csrf = options.readCsrf();
    if (!token || !csrf || signal.aborted) return null;
    const endpoint = input.operation === "visionAnalyze" ? "analyze" : "candidates";
    const response = await options.fetchImpl(
      `${options.apiBaseUrl.replace(/\/$/u, "")}/api/v2/ai/vision/${endpoint}`,
      {
        method: "POST",
        redirect: "error",
        credentials: "include",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        headers: {
          authorization: `Bearer ${token}`,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify(input.body),
      },
    );
    const body = await response.text();
    if (!response.ok || body.length > 220_000 || options.getAccessToken() !== token) return null;
    return JSON.parse(body) as unknown;
  });
}
