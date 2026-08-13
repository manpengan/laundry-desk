import { randomUUID } from "node:crypto";

import type { AiStreamEvent } from "@laundry/contracts";

import {
  SYNTHETIC_TOOL_DESCRIPTOR,
  SyntheticLookupArgsSchema,
  type AiProviderMessage,
  type AiProviderPort,
  type SyntheticToolPort,
} from "./streaming-provider.js";
import type {
  AiConversationStore,
  AiEventDraft,
  AiRequestContext,
  AiTurnRecord,
} from "./streaming-store.js";
import { detectsPromptInjection, redactAiText, sanitizeAiToolPayload } from "./safety-guard.js";
import { AiStreamingRedactor } from "./streaming-redactor.js";
import { finishAiTurn, sha256Text, type AiRuntimeState } from "./streaming-finish.js";

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

async function executeTool(
  store: AiConversationStore,
  tool: SyntheticToolPort,
  turn: AiTurnRecord,
  context: AiRequestContext,
  step: number,
  args: unknown,
  parentSignal: AbortSignal,
): Promise<
  Readonly<{
    message: AiProviderMessage;
    outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  }>
> {
  const parsed = SyntheticLookupArgsSchema.safeParse(args);
  const startedAt = Date.now();
  const safeQuery = parsed.success ? redactAiText(parsed.data.query).text : null;
  const requestHash = sha256Text(
    JSON.stringify(safeQuery === null ? { invalid: true } : { query: safeQuery }),
  );
  const timeoutSignal = AbortSignal.timeout(AI_STREAM_LIMITS.toolTimeoutMs);
  const signal = AbortSignal.any([parentSignal, timeoutSignal]);
  let result: unknown = Object.freeze({ error: "invalid_tool_input" });
  let outcome: "succeeded" | "failed" | "timed_out" | "cancelled" = "failed";
  try {
    if (safeQuery === null || detectsPromptInjection(safeQuery))
      throw new Error("unsafe tool input");
    result = await tool.lookup(Object.freeze({ query: safeQuery }), signal);
    outcome = "succeeded";
  } catch {
    outcome = parentSignal.aborted ? "cancelled" : timeoutSignal.aborted ? "timed_out" : "failed";
    result = Object.freeze({ error: outcome });
  }
  const safeResult = sanitizeAiToolPayload(result);
  const serialized = safeResult.content;
  if (safeResult.blocked) outcome = "failed";
  await store.appendToolAttempt({
    attempt: Object.freeze({
      id: randomUUID(),
      turnId: turn.id,
      step,
      requestSha256: requestHash,
      resultSha256: sha256Text(serialized),
      outcome,
      durationMs: Math.min(AI_STREAM_LIMITS.toolTimeoutMs, Date.now() - startedAt),
      createdAt: new Date(),
    }),
    context,
  });
  return Object.freeze({
    message: Object.freeze({ role: "tool" as const, content: serialized }),
    outcome,
  });
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
  tool: SyntheticToolPort,
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
        tools: Object.freeze([SYNTHETIC_TOOL_DESCRIPTOR]),
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
        if (state.toolSteps > AI_STREAM_LIMITS.maxToolSteps) throw new Error("AI_TOOL_LIMIT");
        if (state.eventCount + 3 > AI_STREAM_LIMITS.maxEvents) throw new Error("AI_OUTPUT_LIMIT");
        if (providerEvent.name !== "synthetic.lookup") throw new Error("AI_PROVIDER_FAILED");
        accountForEvent(
          state,
          await persistEvent(
            store,
            turn.id,
            context,
            { type: "tool_call", tool: "synthetic.lookup", step: state.toolSteps },
            onEvent,
          ),
        );
        const toolResult = await executeTool(
          store,
          tool,
          turn,
          context,
          state.toolSteps,
          providerEvent.args,
          signal,
        );
        accountForEvent(
          state,
          await persistEvent(
            store,
            turn.id,
            context,
            {
              type: "tool_result",
              tool: "synthetic.lookup",
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
