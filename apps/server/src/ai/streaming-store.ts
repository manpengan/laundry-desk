import type { AiSessionView, AiStreamEvent, AiTurnView } from "@laundry/contracts";

import type { TenantContext } from "../db/types.js";

export type AiRequestContext = Readonly<{
  tenant: TenantContext;
  authSessionId: string;
  deviceId: string;
}>;

export type AiTurnRecord = Readonly<{
  id: string;
  sessionId: string;
  idempotencyKey: string;
  prompt: string;
  promptSha256: string;
  maxOutputTokens: number;
  status: AiTurnView["status"];
  createdAt: Date;
}>;

export type AiToolAttemptRecord = Readonly<{
  id: string;
  turnId: string;
  step: number;
  requestSha256: string;
  resultSha256: string | null;
  outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
  durationMs: number;
  createdAt: Date;
}>;

export type AiTurnUsage = Readonly<{
  id: string;
  inputTokens: number;
  outputTokens: number;
  outputBytes: number;
  eventCount: number;
  toolSteps: number;
}>;

export type AiTurnFinish = Readonly<{
  status: "completed" | "failed" | "cancelled";
  errorCode: Extract<AiStreamEvent, { type: "error" }>["code"] | null;
  assistantMessageId: string;
  assistantText: string;
  assistantSha256: string;
  usage: AiTurnUsage;
  auditId: string;
  completedAt: Date;
}>;

export type AiEventDraft =
  | Readonly<{ type: "content_delta"; text: string }>
  | Readonly<{ type: "tool_call"; tool: "synthetic.lookup"; step: number }>
  | Readonly<{
      type: "tool_result";
      tool: "synthetic.lookup";
      step: number;
      outcome: "succeeded" | "failed" | "timed_out" | "cancelled";
    }>
  | Readonly<{
      type: "done";
      finish_reason: "stop" | "limit";
      input_tokens: number;
      output_tokens: number;
    }>
  | Readonly<{
      type: "error";
      code: Extract<AiStreamEvent, { type: "error" }>["code"];
    }>;

export type AiStoreErrorCode =
  "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "ACTIVE_TURN" | "INVALID_STATE";

export class AiStoreError extends Error {
  constructor(readonly code: AiStoreErrorCode) {
    super(code);
    this.name = "AiStoreError";
  }
}

export type AiConversationStore = Readonly<{
  createSession(
    input: Readonly<{
      id: string;
      auditId: string;
      context: AiRequestContext;
      now: Date;
    }>,
  ): Promise<AiSessionView>;
  createTurn(
    input: Readonly<{
      id: string;
      messageId: string;
      auditId: string;
      sessionId: string;
      idempotencyKey: string;
      prompt: string;
      promptSha256: string;
      maxOutputTokens: number;
      context: AiRequestContext;
      now: Date;
    }>,
  ): Promise<Readonly<{ turn: AiTurnRecord; replayed: boolean }>>;
  getSession(sessionId: string, context: AiRequestContext): Promise<AiSessionView | null>;
  getQueuedTurn(sessionId: string, context: AiRequestContext): Promise<AiTurnRecord | null>;
  startTurn(turnId: string, context: AiRequestContext, now: Date): Promise<boolean>;
  appendEvent(
    input: Readonly<{
      id: string;
      turnId: string;
      event: AiEventDraft;
      context: AiRequestContext;
      now: Date;
    }>,
  ): Promise<AiStreamEvent>;
  appendToolAttempt(
    input: Readonly<{
      attempt: AiToolAttemptRecord;
      context: AiRequestContext;
    }>,
  ): Promise<void>;
  finishTurn(
    input: Readonly<{
      turnId: string;
      finish: AiTurnFinish;
      context: AiRequestContext;
    }>,
  ): Promise<boolean>;
  listEvents(
    sessionId: string,
    after: number,
    limit: number,
    context: AiRequestContext,
  ): Promise<readonly AiStreamEvent[]>;
  listMessages(
    sessionId: string,
    context: AiRequestContext,
  ): Promise<readonly Readonly<{ role: "user" | "assistant"; content: string }>[]>;
}>;
