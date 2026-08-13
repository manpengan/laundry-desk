import { AiStreamEventSchema, type AiSessionView, type AiStreamEvent } from "@laundry/contracts";

import {
  AiStoreError,
  type AiConversationStore,
  type AiRequestContext,
  type AiToolAttemptRecord,
  type AiTurnRecord,
  type AiTurnUsage,
} from "./streaming-store.js";

type MemorySession = Readonly<{
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

type MemoryTurn = AiTurnRecord &
  Readonly<{
    orgId: string;
    storeId: string;
    staffId: string;
    authSessionId: string;
    outputBytes: number;
    eventCount: number;
    toolSteps: number;
  }>;

type MemoryMessage = Readonly<{
  id: string;
  sessionId: string;
  turnId: string;
  role: "user" | "assistant";
  content: string;
  sha256: string;
  sequence: number;
  createdAt: Date;
}>;

type SafeAudit = Readonly<{
  command: "ai.session.create" | "ai.turn.create" | "ai.turn.finish";
  entityId: string;
  metadata: Readonly<Record<string, number | string>>;
}>;

function sameContext(session: MemorySession, context: AiRequestContext): boolean {
  return (
    session.orgId === context.tenant.orgId &&
    session.storeId === context.tenant.storeId &&
    session.staffId === context.tenant.staffId &&
    session.authSessionId === context.authSessionId
  );
}

function sessionView(session: MemorySession): AiSessionView {
  return Object.freeze({
    session_id: session.id,
    status: session.status,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
  });
}

function publicTurn(turn: MemoryTurn): AiTurnRecord {
  return Object.freeze({
    id: turn.id,
    sessionId: turn.sessionId,
    idempotencyKey: turn.idempotencyKey,
    prompt: turn.prompt,
    promptSha256: turn.promptSha256,
    maxOutputTokens: turn.maxOutputTokens,
    status: turn.status,
    createdAt: new Date(turn.createdAt),
  });
}

function eventBytes(event: Parameters<AiConversationStore["appendEvent"]>[0]["event"]): number {
  return event.type === "content_delta" ? Buffer.byteLength(event.text, "utf8") : 0;
}

export class MemoryAiConversationStore implements AiConversationStore {
  private sessions = new Map<string, MemorySession>();
  private turns = new Map<string, MemoryTurn>();
  private messages: readonly MemoryMessage[] = Object.freeze([]);
  private events: readonly AiStreamEvent[] = Object.freeze([]);
  private attempts: readonly AiToolAttemptRecord[] = Object.freeze([]);
  private usage: readonly AiTurnUsage[] = Object.freeze([]);
  private audits: readonly SafeAudit[] = Object.freeze([]);

  async createSession(input: Parameters<AiConversationStore["createSession"]>[0]) {
    const session: MemorySession = Object.freeze({
      id: input.id,
      orgId: input.context.tenant.orgId,
      storeId: input.context.tenant.storeId,
      staffId: input.context.tenant.staffId,
      authSessionId: input.context.authSessionId,
      status: "open" as const,
      nextCursor: 0,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    });
    this.sessions = new Map(this.sessions).set(session.id, session);
    this.audits = Object.freeze([
      ...this.audits,
      Object.freeze({
        command: "ai.session.create" as const,
        entityId: session.id,
        metadata: Object.freeze({ status: "open" }),
      }),
    ]);
    return sessionView(session);
  }

  async createTurn(input: Parameters<AiConversationStore["createTurn"]>[0]) {
    const session = this.sessions.get(input.sessionId);
    if (session === undefined || !sameContext(session, input.context)) {
      throw new AiStoreError("NOT_FOUND");
    }
    const existing = [...this.turns.values()].find(
      (turn) => turn.sessionId === input.sessionId && turn.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) {
      if (
        existing.promptSha256 !== input.promptSha256 ||
        existing.maxOutputTokens !== input.maxOutputTokens
      ) {
        throw new AiStoreError("IDEMPOTENCY_CONFLICT");
      }
      return Object.freeze({ turn: publicTurn(existing), replayed: true });
    }
    if (
      [...this.turns.values()].some(
        (turn) =>
          turn.sessionId === input.sessionId &&
          (turn.status === "queued" || turn.status === "running"),
      )
    ) {
      throw new AiStoreError("ACTIVE_TURN");
    }
    const turn: MemoryTurn = Object.freeze({
      id: input.id,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      prompt: input.prompt,
      promptSha256: input.promptSha256,
      maxOutputTokens: input.maxOutputTokens,
      status: "queued" as const,
      createdAt: new Date(input.now),
      orgId: session.orgId,
      storeId: session.storeId,
      staffId: session.staffId,
      authSessionId: session.authSessionId,
      outputBytes: 0,
      eventCount: 0,
      toolSteps: 0,
    });
    this.turns = new Map(this.turns).set(turn.id, turn);
    this.sessions = new Map(this.sessions).set(
      session.id,
      Object.freeze({ ...session, status: "open" as const, updatedAt: new Date(input.now) }),
    );
    this.messages = Object.freeze([
      ...this.messages,
      Object.freeze({
        id: input.messageId,
        sessionId: session.id,
        turnId: turn.id,
        role: "user" as const,
        content: input.prompt,
        sha256: input.promptSha256,
        sequence: this.messages.filter((message) => message.sessionId === session.id).length + 1,
        createdAt: new Date(input.now),
      }),
    ]);
    this.audits = Object.freeze([
      ...this.audits,
      Object.freeze({
        command: "ai.turn.create" as const,
        entityId: turn.id,
        metadata: Object.freeze({
          prompt_sha256: input.promptSha256,
          prompt_chars: input.prompt.length,
          max_output_tokens: input.maxOutputTokens,
        }),
      }),
    ]);
    return Object.freeze({ turn: publicTurn(turn), replayed: false });
  }

  async getSession(sessionId: string, context: AiRequestContext) {
    const session = this.sessions.get(sessionId);
    return session === undefined || !sameContext(session, context) ? null : sessionView(session);
  }

  async getQueuedTurn(sessionId: string, context: AiRequestContext) {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !sameContext(session, context)) return null;
    const turn = [...this.turns.values()].find(
      (candidate) => candidate.sessionId === sessionId && candidate.status === "queued",
    );
    return turn === undefined ? null : publicTurn(turn);
  }

  async startTurn(turnId: string, context: AiRequestContext, now: Date): Promise<boolean> {
    const turn = this.turns.get(turnId);
    const session = turn === undefined ? undefined : this.sessions.get(turn.sessionId);
    if (
      turn === undefined ||
      session === undefined ||
      !sameContext(session, context) ||
      turn.status !== "queued"
    ) {
      return false;
    }
    this.turns = new Map(this.turns).set(
      turn.id,
      Object.freeze({ ...turn, status: "running" as const }),
    );
    this.sessions = new Map(this.sessions).set(
      session.id,
      Object.freeze({ ...session, status: "running" as const, updatedAt: new Date(now) }),
    );
    return true;
  }

  async appendEvent(input: Parameters<AiConversationStore["appendEvent"]>[0]) {
    const turn = this.turns.get(input.turnId);
    const session = turn === undefined ? undefined : this.sessions.get(turn.sessionId);
    if (
      turn === undefined ||
      session === undefined ||
      !sameContext(session, input.context) ||
      turn.status !== "running"
    ) {
      throw new AiStoreError("INVALID_STATE");
    }
    const cursor = session.nextCursor + 1;
    const event = AiStreamEventSchema.parse({
      ...input.event,
      cursor,
      turn_id: turn.id,
      at: input.now.toISOString(),
    });
    this.events = Object.freeze([...this.events, Object.freeze(event)]);
    this.turns = new Map(this.turns).set(
      turn.id,
      Object.freeze({
        ...turn,
        outputBytes: turn.outputBytes + eventBytes(input.event),
        eventCount: turn.eventCount + 1,
        toolSteps:
          input.event.type === "tool_call" || input.event.type === "tool_result"
            ? Math.max(turn.toolSteps, input.event.step)
            : turn.toolSteps,
      }),
    );
    this.sessions = new Map(this.sessions).set(
      session.id,
      Object.freeze({ ...session, nextCursor: cursor, updatedAt: new Date(input.now) }),
    );
    return Object.freeze(event);
  }

  async appendToolAttempt(
    input: Parameters<AiConversationStore["appendToolAttempt"]>[0],
  ): Promise<void> {
    const turn = this.turns.get(input.attempt.turnId);
    const session = turn === undefined ? undefined : this.sessions.get(turn.sessionId);
    if (session === undefined || !sameContext(session, input.context)) {
      throw new AiStoreError("NOT_FOUND");
    }
    this.attempts = Object.freeze([...this.attempts, Object.freeze({ ...input.attempt })]);
  }

  async finishTurn(input: Parameters<AiConversationStore["finishTurn"]>[0]): Promise<boolean> {
    const turn = this.turns.get(input.turnId);
    const session = turn === undefined ? undefined : this.sessions.get(turn.sessionId);
    if (
      turn === undefined ||
      session === undefined ||
      !sameContext(session, input.context) ||
      turn.status !== "running"
    ) {
      return false;
    }
    this.turns = new Map(this.turns).set(
      turn.id,
      Object.freeze({ ...turn, status: input.finish.status }),
    );
    this.sessions = new Map(this.sessions).set(
      session.id,
      Object.freeze({
        ...session,
        status: input.finish.status,
        updatedAt: new Date(input.finish.completedAt),
      }),
    );
    if (input.finish.assistantText.length > 0) {
      this.messages = Object.freeze([
        ...this.messages,
        Object.freeze({
          id: input.finish.assistantMessageId,
          sessionId: session.id,
          turnId: turn.id,
          role: "assistant" as const,
          content: input.finish.assistantText,
          sha256: input.finish.assistantSha256,
          sequence: this.messages.filter((message) => message.sessionId === session.id).length + 1,
          createdAt: new Date(input.finish.completedAt),
        }),
      ]);
    }
    this.usage = Object.freeze([...this.usage, Object.freeze({ ...input.finish.usage })]);
    this.audits = Object.freeze([
      ...this.audits,
      Object.freeze({
        command: "ai.turn.finish" as const,
        entityId: turn.id,
        metadata: Object.freeze({
          status: input.finish.status,
          input_tokens: input.finish.usage.inputTokens,
          output_tokens: input.finish.usage.outputTokens,
          output_bytes: input.finish.usage.outputBytes,
          event_count: input.finish.usage.eventCount,
          tool_steps: input.finish.usage.toolSteps,
        }),
      }),
    ]);
    return true;
  }

  async listEvents(sessionId: string, after: number, limit: number, context: AiRequestContext) {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !sameContext(session, context))
      throw new AiStoreError("NOT_FOUND");
    return Object.freeze(
      this.events
        .filter(
          (event) => event.cursor > after && this.turns.get(event.turn_id)?.sessionId === sessionId,
        )
        .slice(0, limit),
    );
  }

  async listMessages(sessionId: string, context: AiRequestContext) {
    const session = this.sessions.get(sessionId);
    if (session === undefined || !sameContext(session, context))
      throw new AiStoreError("NOT_FOUND");
    return Object.freeze(
      this.messages
        .filter((message) => message.sessionId === sessionId)
        .sort((left, right) => left.sequence - right.sequence)
        .map((message) => Object.freeze({ role: message.role, content: message.content })),
    );
  }

  auditSnapshot(): readonly SafeAudit[] {
    return Object.freeze(this.audits.map((audit) => Object.freeze({ ...audit })));
  }

  toolAttemptSnapshot(): readonly AiToolAttemptRecord[] {
    return Object.freeze(this.attempts.map((attempt) => Object.freeze({ ...attempt })));
  }

  usageSnapshot(): readonly AiTurnUsage[] {
    return Object.freeze(this.usage.map((entry) => Object.freeze({ ...entry })));
  }
}
