import { randomUUID } from "node:crypto";

import {
  AI_ASSISTANT_MAX_TOOL_CALLS,
  type AiStreamEvent,
  type AiStreamToolName,
} from "@laundry/contracts";

import {
  ASSISTANT_TOOL_DESCRIPTORS,
  SYNTHETIC_TOOL_DESCRIPTOR,
  type AiProviderMessage,
  type AiProviderPort,
  type ReadonlyAssistantToolPort,
  type SyntheticToolPort,
} from "./streaming-provider.js";
import type {
  AiConversationStore,
  AiEventDraft,
  AiRequestContext,
  AiTurnRecord,
} from "./streaming-store.js";
import { AiStreamingRedactor } from "./streaming-redactor.js";
import { finishAiTurn, type AiRuntimeState } from "./streaming-finish.js";
import { executeAiTool } from "./streaming-tool-executor.js";

export { sha256Text } from "./streaming-finish.js";

export const AI_STREAM_LIMITS = Object.freeze({
  maxToolSteps: 4,
  toolTimeoutMs: 1_000,
  totalDeadlineMs: 15_000,
  maxInputTokens: 20_000,
  maxOutputBytes: 32_768,
  maxOutputChars: 8_000,
  maxOutputTokens: 1_024,
  maxEvents: 256,
});

type SafeErrorCode = Extract<AiStreamEvent, { type: "error" }>["code"];

function linkedAbort(parent: AbortSignal): Readonly<{
  signal: AbortSignal;
  dispose: () => void;
}> {
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(AI_STREAM_LIMITS.totalDeadlineMs);
  const parentAbort = () => controller.abort("AI_ABORTED");
  const deadlineAbort = () => controller.abort("AI_DEADLINE_EXCEEDED");
  parent.addEventListener("abort", parentAbort, { once: true });
  deadline.addEventListener("abort", deadlineAbort, { once: true });
  if (parent.aborted) parentAbort();
  else if (deadline.aborted) deadlineAbort();
  return Object.freeze({
    signal: controller.signal,
    dispose: () => {
      parent.removeEventListener("abort", parentAbort);
      deadline.removeEventListener("abort", deadlineAbort);
    },
  });
}

async function persistEvent(
  store: AiConversationStore,
  turnId: string,
  context: AiRequestContext,
  event: AiEventDraft,
  onEvent: (event: AiStreamEvent) => Promise<void>,
): Promise<AiStreamEvent> {
  const persisted = await store.appendEvent({
    id: randomUUID(),
    turnId,
    event,
    context,
    now: new Date(),
  });
  await onEvent(persisted);
  return persisted;
}

function accountForEvent(state: AiRuntimeState, event: AiStreamEvent): void {
  state.eventCount += 1;
  if (event.type !== "content_delta") return;
  state.outputBytes += Buffer.byteLength(event.text, "utf8");
  state.assistantText += event.text;
}

async function persistContent(
  state: AiRuntimeState,
  store: AiConversationStore,
  turn: AiTurnRecord,
  context: AiRequestContext,
  text: string | null,
  onEvent: (event: AiStreamEvent) => Promise<void>,
): Promise<void> {
  if (text === null || text.length === 0) return;
  const nextBytes = state.outputBytes + Buffer.byteLength(text, "utf8");
  if (
    nextBytes > AI_STREAM_LIMITS.maxOutputBytes ||
    state.assistantText.length + text.length > AI_STREAM_LIMITS.maxOutputChars ||
    state.eventCount + 1 >= AI_STREAM_LIMITS.maxEvents
  ) {
    throw new Error("AI_OUTPUT_LIMIT");
  }
  accountForEvent(
    state,
    await persistEvent(store, turn.id, context, { type: "content_delta", text }, onEvent),
  );
}

function safeErrorCode(error: unknown, signal: AbortSignal): SafeErrorCode {
  const rawCode = error instanceof Error ? error.message : "AI_PROVIDER_FAILED";
  if (signal.aborted && rawCode !== "AI_TOOL_TIMEOUT") {
    return signal.reason === "AI_DEADLINE_EXCEEDED" ? "AI_DEADLINE_EXCEEDED" : "AI_ABORTED";
  }
  if (
    rawCode === "AI_OUTPUT_LIMIT" ||
    rawCode === "AI_TOOL_LIMIT" ||
    rawCode === "AI_TOOL_TIMEOUT" ||
    rawCode === "AI_ABORTED"
  ) {
    return rawCode;
  }
  if (rawCode === "AI_BUDGET_EXCEEDED" || rawCode === "AI_CIRCUIT_OPEN") {
    return "AI_UNAVAILABLE";
  }
  return "AI_PROVIDER_FAILED";
}

async function runLoop(
  store: AiConversationStore,
  provider: AiProviderPort,
  syntheticTool: SyntheticToolPort,
  assistantTool: ReadonlyAssistantToolPort | undefined,
  turn: AiTurnRecord,
  messages: readonly AiProviderMessage[],
  context: AiRequestContext,
  signal: AbortSignal,
  onEvent: (event: AiStreamEvent) => Promise<void>,
  safety: Readonly<{
    denialCode: "AI_BUDGET_EXCEEDED" | "AI_CIRCUIT_OPEN" | null;
    inputRedactions: number;
    inputMicrosPerMillion: number;
    outputMicrosPerMillion: number;
  }>,
): Promise<void> {
  const state: AiRuntimeState = {
    assistantText: "",
    outputBytes: 0,
    eventCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolSteps: 0,
    finishReason: "stop",
    inputRedactions: safety.inputRedactions,
    outputRedactions: 0,
    inputMicrosPerMillion: safety.inputMicrosPerMillion,
    outputMicrosPerMillion: safety.outputMicrosPerMillion,
  };
  let activeMessages = [...messages];
  let providerEventCount = 0;
  try {
    if (safety.denialCode !== null) throw new Error(safety.denialCode);
    while (!signal.aborted) {
      let continueWithTool = false;
      const outputRedactor = new AiStreamingRedactor();
      for await (const providerEvent of provider.stream({
        messages: Object.freeze(activeMessages),
        tools:
          assistantTool === undefined
            ? Object.freeze([SYNTHETIC_TOOL_DESCRIPTOR])
            : ASSISTANT_TOOL_DESCRIPTORS,
        maxOutputTokens: turn.maxOutputTokens,
        signal,
      })) {
        providerEventCount += 1;
        if (providerEventCount >= AI_STREAM_LIMITS.maxEvents) {
          throw new Error("AI_OUTPUT_LIMIT");
        }
        if (providerEvent.type === "delta") {
          await persistContent(
            state,
            store,
            turn,
            context,
            outputRedactor.push(providerEvent.text),
            onEvent,
          );
          continue;
        }
        await persistContent(state, store, turn, context, outputRedactor.flush(), onEvent);
        state.outputRedactions += outputRedactor.drainRedactionCount();
        if (providerEvent.type === "error") throw new Error("AI_PROVIDER_FAILED");
        if (providerEvent.type === "end") {
          const nextInputTokens = state.inputTokens + providerEvent.inputTokens;
          const nextOutputTokens = state.outputTokens + providerEvent.outputTokens;
          if (nextInputTokens > AI_STREAM_LIMITS.maxInputTokens) throw new Error("AI_OUTPUT_LIMIT");
          if (
            nextOutputTokens > turn.maxOutputTokens ||
            nextOutputTokens > AI_STREAM_LIMITS.maxOutputTokens
          ) {
            throw new Error("AI_OUTPUT_LIMIT");
          }
          state.inputTokens = nextInputTokens;
          state.outputTokens = nextOutputTokens;
          continueWithTool = providerEvent.finishReason === "tool_calls";
          continue;
        }
        state.toolSteps += 1;
        const toolLimit =
          assistantTool === undefined ? AI_STREAM_LIMITS.maxToolSteps : AI_ASSISTANT_MAX_TOOL_CALLS;
        if (state.toolSteps > toolLimit) throw new Error("AI_TOOL_LIMIT");
        if (state.eventCount + 3 > AI_STREAM_LIMITS.maxEvents) throw new Error("AI_OUTPUT_LIMIT");
        const toolName = providerEvent.name as AiStreamToolName;
        const isAssistantTool = ASSISTANT_TOOL_DESCRIPTORS.some(
          (descriptor) => descriptor.name === providerEvent.name,
        );
        if (
          (assistantTool === undefined && toolName !== "synthetic.lookup") ||
          (assistantTool !== undefined && !isAssistantTool)
        ) {
          throw new Error("AI_PROVIDER_FAILED");
        }
        accountForEvent(
          state,
          await persistEvent(
            store,
            turn.id,
            context,
            { type: "tool_call", tool: toolName, step: state.toolSteps },
            onEvent,
          ),
        );
        const toolResult = await executeAiTool({
          store,
          syntheticTool,
          ...(assistantTool === undefined ? {} : { assistantTool }),
          turn,
          context,
          step: state.toolSteps,
          name: toolName,
          args: providerEvent.args,
          parentSignal: signal,
        });
        accountForEvent(
          state,
          await persistEvent(
            store,
            turn.id,
            context,
            {
              type: "tool_result",
              tool: toolName,
              step: state.toolSteps,
              outcome: toolResult.outcome,
            },
            onEvent,
          ),
        );
        if (toolResult.outcome === "timed_out") throw new Error("AI_TOOL_TIMEOUT");
        if (toolResult.outcome === "cancelled") throw new Error("AI_ABORTED");
        activeMessages = [
          ...activeMessages,
          Object.freeze({
            role: "assistant" as const,
            content: "",
            toolCallId: providerEvent.callId,
            toolName: "synthetic.lookup" as const,
            toolArgs: providerEvent.args,
          }),
          Object.freeze({ ...toolResult.message, toolCallId: providerEvent.callId }),
        ];
        continueWithTool = true;
      }
      await persistContent(state, store, turn, context, outputRedactor.flush(), onEvent);
      state.outputRedactions += outputRedactor.drainRedactionCount();
      if (continueWithTool) continue;
      accountForEvent(
        state,
        await persistEvent(
          store,
          turn.id,
          context,
          {
            type: "done",
            finish_reason: state.finishReason,
            input_tokens: state.inputTokens,
            output_tokens: Math.min(state.outputTokens, turn.maxOutputTokens),
          },
          onEvent,
        ),
      );
      await finishAiTurn(store, turn, context, state, "completed", null);
      return;
    }
    throw new Error("AI_ABORTED");
  } catch (error) {
    const errorCode = safeErrorCode(error, signal);
    try {
      accountForEvent(
        state,
        await persistEvent(store, turn.id, context, { type: "error", code: errorCode }, onEvent),
      );
    } catch {
      // The event is durable even if the disconnected client rejects delivery.
    }
    await finishAiTurn(
      store,
      turn,
      context,
      state,
      errorCode === "AI_ABORTED" ? "cancelled" : "failed",
      errorCode,
    );
  }
}

export async function runAiTurn(
  input: Readonly<{
    store: AiConversationStore;
    provider: AiProviderPort;
    tool: SyntheticToolPort;
    assistantTool?: ReadonlyAssistantToolPort;
    turn: AiTurnRecord;
    messages: readonly AiProviderMessage[];
    context: AiRequestContext;
    parentSignal: AbortSignal;
    onEvent: (event: AiStreamEvent) => Promise<void>;
    safety: Readonly<{
      denialCode: "AI_BUDGET_EXCEEDED" | "AI_CIRCUIT_OPEN" | null;
      inputRedactions: number;
      inputMicrosPerMillion: number;
      outputMicrosPerMillion: number;
    }>;
  }>,
): Promise<void> {
  const linked = linkedAbort(input.parentSignal);
  try {
    await runLoop(
      input.store,
      input.provider,
      input.tool,
      input.assistantTool,
      input.turn,
      input.messages,
      input.context,
      linked.signal,
      input.onEvent,
      input.safety,
    );
  } finally {
    linked.dispose();
  }
}
