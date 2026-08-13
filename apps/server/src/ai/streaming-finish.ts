import { createHash, randomUUID } from "node:crypto";

import type { AiStreamEvent } from "@laundry/contracts";

import { estimateCostMicros } from "./safety-guard.js";
import type { AiConversationStore, AiRequestContext, AiTurnRecord } from "./streaming-store.js";

export type AiRuntimeState = {
  assistantText: string;
  outputBytes: number;
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  toolSteps: number;
  finishReason: "stop" | "limit";
  inputRedactions: number;
  outputRedactions: number;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
};

type SafeErrorCode = Extract<AiStreamEvent, { type: "error" }>["code"];

export const sha256Text = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export async function finishAiTurn(
  store: AiConversationStore,
  turn: AiTurnRecord,
  context: AiRequestContext,
  state: AiRuntimeState,
  status: "completed" | "failed" | "cancelled",
  errorCode: SafeErrorCode | null,
): Promise<void> {
  const completedAt = new Date();
  await store.finishTurn({
    turnId: turn.id,
    context,
    finish: Object.freeze({
      status,
      errorCode,
      assistantMessageId: randomUUID(),
      assistantText: state.assistantText,
      assistantSha256: sha256Text(state.assistantText),
      usage: Object.freeze({
        id: randomUUID(),
        createdAt: completedAt,
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        outputBytes: state.outputBytes,
        eventCount: state.eventCount,
        toolSteps: state.toolSteps,
        estimatedCostMicros: estimateCostMicros(
          state.inputTokens,
          state.outputTokens,
          state.inputMicrosPerMillion,
          state.outputMicrosPerMillion,
        ),
        inputRedactions: state.inputRedactions,
        outputRedactions: state.outputRedactions,
      }),
      auditId: randomUUID(),
      completedAt,
    }),
  });
}
