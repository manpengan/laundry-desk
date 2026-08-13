import { randomUUID } from "node:crypto";

import {
  AI_ASSISTANT_TOOL_TIMEOUT_MS,
  type AiAssistantToolCall,
  type AiAssistantToolResult,
  type AiStreamToolName,
} from "@laundry/contracts";

import { detectsPromptInjection, redactAiText, sanitizeAiToolPayload } from "./safety-guard.js";
import { sha256Text } from "./streaming-finish.js";
import {
  SyntheticLookupArgsSchema,
  parseAssistantToolCall,
  type AiProviderMessage,
  type ReadonlyAssistantToolPort,
  type SyntheticToolPort,
} from "./streaming-provider.js";
import type { AiConversationStore, AiRequestContext, AiTurnRecord } from "./streaming-store.js";

const SYNTHETIC_TOOL_TIMEOUT_MS = 1_000;
type ToolOutcome = "succeeded" | "failed" | "timed_out" | "cancelled";
type PreparedInput = Readonly<{
  syntheticQuery: string | null;
  assistantCall: AiAssistantToolCall | null;
  requestHash: string;
}>;
type ToolAbortScope = Readonly<{
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
}>;

function createToolAbortScope(parentSignal: AbortSignal, timeoutMs: number): ToolAbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort("AI_TOOL_TIMEOUT");
  }, timeoutMs);
  return Object.freeze({
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeoutHandle);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  });
}

function prepareInput(name: AiStreamToolName, args: unknown): PreparedInput {
  const synthetic = name === "synthetic.lookup" ? SyntheticLookupArgsSchema.safeParse(args) : null;
  const assistant = name === "synthetic.lookup" ? null : parseAssistantToolCall(name, args);
  const request =
    synthetic?.success === true
      ? { query: synthetic.data.query }
      : assistant === null
        ? { invalid: true }
        : assistant.args;
  const safeRequest = redactAiText(JSON.stringify(request)).text;
  if (detectsPromptInjection(safeRequest)) throw new Error("unsafe tool input");
  return Object.freeze({
    syntheticQuery: synthetic?.success === true ? redactAiText(synthetic.data.query).text : null,
    assistantCall: assistant,
    requestHash: sha256Text(safeRequest),
  });
}

async function invokeTool(
  name: AiStreamToolName,
  prepared: PreparedInput,
  syntheticTool: SyntheticToolPort,
  assistantTool: ReadonlyAssistantToolPort | undefined,
  context: AiRequestContext,
  signal: AbortSignal,
): Promise<unknown> {
  if (name === "synthetic.lookup") {
    if (prepared.syntheticQuery === null) throw new Error("invalid tool input");
    return syntheticTool.lookup(Object.freeze({ query: prepared.syntheticQuery }), signal);
  }
  if (assistantTool === undefined || prepared.assistantCall === null) {
    throw new Error("tool unavailable");
  }
  return assistantTool.execute(prepared.assistantCall, context, signal);
}

function resultCounts(result: unknown) {
  const assistant = result as AiAssistantToolResult;
  return typeof assistant.result_count === "number" &&
    Array.isArray(assistant.sources) &&
    Array.isArray(assistant.filters)
    ? Object.freeze({
        resultCount: assistant.result_count,
        sourceCount: assistant.sources.length,
        filterCount: assistant.filters.length,
      })
    : Object.freeze({ resultCount: 0, sourceCount: 0, filterCount: 0 });
}

export async function executeAiTool(
  input: Readonly<{
    store: AiConversationStore;
    syntheticTool: SyntheticToolPort;
    assistantTool?: ReadonlyAssistantToolPort;
    turn: AiTurnRecord;
    context: AiRequestContext;
    step: number;
    name: AiStreamToolName;
    args: unknown;
    parentSignal: AbortSignal;
  }>,
): Promise<Readonly<{ message: AiProviderMessage; outcome: ToolOutcome }>> {
  const startedAt = Date.now();
  const timeoutMs =
    input.name === "synthetic.lookup" ? SYNTHETIC_TOOL_TIMEOUT_MS : AI_ASSISTANT_TOOL_TIMEOUT_MS;
  const abortScope = createToolAbortScope(input.parentSignal, timeoutMs);
  let requestHash = sha256Text('{"invalid":true}');
  let result: unknown = Object.freeze({ error: "invalid_tool_input" });
  let outcome: ToolOutcome = "failed";
  try {
    const prepared = prepareInput(input.name, input.args);
    requestHash = prepared.requestHash;
    result = await invokeTool(
      input.name,
      prepared,
      input.syntheticTool,
      input.assistantTool,
      input.context,
      abortScope.signal,
    );
    outcome = "succeeded";
  } catch {
    outcome = input.parentSignal.aborted
      ? "cancelled"
      : abortScope.didTimeout()
        ? "timed_out"
        : "failed";
    result = Object.freeze({ error: outcome });
  } finally {
    abortScope.dispose();
  }
  const counts = resultCounts(result);
  const safeResult = sanitizeAiToolPayload(result);
  if (safeResult.blocked) outcome = "failed";
  await input.store.appendToolAttempt({
    attempt: Object.freeze({
      id: randomUUID(),
      turnId: input.turn.id,
      step: input.step,
      toolName: input.name,
      requestSha256: requestHash,
      resultSha256: sha256Text(safeResult.content),
      outcome,
      durationMs: Math.min(timeoutMs, Date.now() - startedAt),
      ...counts,
      auditId: randomUUID(),
      createdAt: new Date(),
    }),
    context: input.context,
  });
  return Object.freeze({
    message: Object.freeze({ role: "tool" as const, content: safeResult.content }),
    outcome,
  });
}
