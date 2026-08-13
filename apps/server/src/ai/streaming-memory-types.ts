import type { AiSessionView } from "@laundry/contracts";

import type { AiConversationStore, AiRequestContext, AiTurnRecord } from "./streaming-store.js";

export type MemorySession = Readonly<{
  id: string;
  orgId: string;
  storeId: string;
  staffId: string;
  authSessionId: string;
  status: AiSessionView["status"];
  nextCursor: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MemoryTurn = AiTurnRecord &
  Readonly<{
    orgId: string;
    storeId: string;
    staffId: string;
    authSessionId: string;
    outputBytes: number;
    eventCount: number;
    toolSteps: number;
  }>;

export type MemoryMessage = Readonly<{
  id: string;
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  sha256: string;
  sequence: number;
  createdAt: Date;
}>;

export type SafeAudit = Readonly<{
  command: "ai.session.create" | "ai.turn.create" | "ai.turn.finish" | "ai.safety.reject";
  entityId: string;
  metadata: Readonly<Record<string, number | string>>;
}>;

export function sameContext(session: MemorySession, context: AiRequestContext): boolean {
  return (
    session.orgId === context.tenant.orgId &&
    session.storeId === context.tenant.storeId &&
    session.staffId === context.tenant.staffId &&
    session.authSessionId === context.authSessionId
  );
}

export function sessionView(session: MemorySession): AiSessionView {
  return Object.freeze({
    session_id: session.id,
    status: session.status,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
  });
}

export function publicTurn(turn: MemoryTurn): AiTurnRecord {
  return Object.freeze({
    id: turn.id,
    sessionId: turn.sessionId,
    idempotencyKey: turn.idempotencyKey,
    prompt: turn.prompt,
    promptSha256: turn.promptSha256,
    maxOutputTokens: turn.maxOutputTokens,
    inputRedactions: turn.inputRedactions,
    status: turn.status,
    createdAt: new Date(turn.createdAt),
  });
}

export function eventBytes(
  event: Parameters<AiConversationStore["appendEvent"]>[0]["event"],
): number {
  return event.type === "content_delta" ? Buffer.byteLength(event.text, "utf8") : 0;
}
