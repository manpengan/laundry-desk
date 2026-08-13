import { randomUUID } from "node:crypto";

import {
  AiTurnCreateRequestSchema,
  type AiSafetyStatusView,
  type AiSessionView,
  type AiStreamEvent,
  type AiTurnCreateRequest,
  type AiTurnView,
} from "@laundry/contracts";

import { type AiProviderPort, type SyntheticToolPort } from "./streaming-provider.js";
import { runAiTurn, sha256Text } from "./streaming-runner.js";
import {
  AiStoreError,
  type AiConversationStore,
  type AiRequestContext,
} from "./streaming-store.js";
import { detectsPromptInjection, redactAiText } from "./safety-guard.js";

export { AI_STREAM_LIMITS } from "./streaming-runner.js";

type AiServiceErrorCode =
  | "AI_UNAVAILABLE"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "ACTIVE_TURN"
  | "PROMPT_INJECTION_DETECTED";

export class AiServiceError extends Error {
  constructor(readonly code: AiServiceErrorCode) {
    super(code);
    this.name = "AiServiceError";
  }
}

export type AiStreamingService = Readonly<{
  enabled: boolean;
  createSession(context: AiRequestContext): Promise<AiSessionView>;
  createTurn(
    sessionId: string,
    input: AiTurnCreateRequest,
    context: AiRequestContext,
  ): Promise<AiTurnView>;
  getSession(sessionId: string, context: AiRequestContext): Promise<AiSessionView>;
  listEvents(
    sessionId: string,
    after: number,
    limit: number,
    context: AiRequestContext,
  ): Promise<readonly AiStreamEvent[]>;
  getSafetyStatus(context: AiRequestContext): Promise<AiSafetyStatusView>;
  runQueuedTurn(
    sessionId: string,
    context: AiRequestContext,
    signal: AbortSignal,
    onEvent: (event: AiStreamEvent) => Promise<void>,
  ): Promise<void>;
}>;

function mapStoreError(error: unknown): never {
  if (error instanceof AiStoreError) {
    if (error.code === "IDEMPOTENCY_CONFLICT") throw new AiServiceError("IDEMPOTENCY_CONFLICT");
    if (error.code === "ACTIVE_TURN") throw new AiServiceError("ACTIVE_TURN");
    if (error.code === "NOT_FOUND") throw new AiServiceError("NOT_FOUND");
  }
  throw error;
}

export function createAiStreamingService(
  options: Readonly<{
    store: AiConversationStore;
    provider: AiProviderPort | null;
    tool: SyntheticToolPort;
  }>,
): AiStreamingService {
  const requireEnabled = (): AiProviderPort => {
    if (options.provider === null || options.provider.kind !== "deterministic_fake") {
      throw new AiServiceError("AI_UNAVAILABLE");
    }
    return options.provider;
  };
  return Object.freeze({
    enabled: options.provider !== null && options.provider.kind === "deterministic_fake",
    async createSession(context) {
      requireEnabled();
      return options.store.createSession({
        id: randomUUID(),
        auditId: randomUUID(),
        context,
        now: new Date(),
      });
    },
    async createTurn(sessionId, input, context) {
      requireEnabled();
      try {
        const boundedInput = AiTurnCreateRequestSchema.parse(input);
        const redacted = redactAiText(boundedInput.prompt);
        const safeInput = AiTurnCreateRequestSchema.parse({
          ...boundedInput,
          prompt: redacted.text,
        });
        if (detectsPromptInjection(redacted.text)) {
          await options.store.recordSafetyRejection({
            id: randomUUID(),
            auditId: randomUUID(),
            sessionId,
            code: "AI_PROMPT_INJECTION",
            contentSha256: sha256Text(redacted.text),
            context,
            now: new Date(),
          });
          throw new AiServiceError("PROMPT_INJECTION_DETECTED");
        }
        const created = await options.store.createTurn({
          id: randomUUID(),
          messageId: randomUUID(),
          auditId: randomUUID(),
          sessionId,
          idempotencyKey: safeInput.idempotency_key,
          prompt: redacted.text,
          promptSha256: sha256Text(redacted.text),
          maxOutputTokens: safeInput.max_output_tokens,
          inputRedactions: redacted.redactionCount,
          context,
          now: new Date(),
        });
        return Object.freeze({
          turn_id: created.turn.id,
          session_id: created.turn.sessionId,
          status: created.turn.status,
          stream_url: `/api/v2/ai/sessions/${created.turn.sessionId}/stream`,
          replayed: created.replayed,
          created_at: created.turn.createdAt.toISOString(),
        });
      } catch (error) {
        return mapStoreError(error);
      }
    },
    async getSession(sessionId, context) {
      const session = await options.store.getSession(sessionId, context);
      if (session === null) throw new AiServiceError("NOT_FOUND");
      return session;
    },
    async listEvents(sessionId, after, limit, context) {
      try {
        return await options.store.listEvents(sessionId, after, limit, context);
      } catch (error) {
        return mapStoreError(error);
      }
    },
    async getSafetyStatus(context) {
      const status = await options.store.getSafetyStatus(context, new Date());
      return Object.freeze({
        runtime_enabled: options.provider !== null && status.monthly_limit_micros > 0,
        ...status,
      });
    },
    async runQueuedTurn(sessionId, context, parentSignal, onEvent) {
      const provider = requireEnabled();
      const turn = await options.store.getQueuedTurn(sessionId, context);
      if (turn === null) return;
      const messages = (await options.store.listMessages(sessionId, context)).map((message) =>
        Object.freeze({ role: message.role, content: message.content }),
      );
      const start = await options.store.authorizeAndStartTurn({
        turnId: turn.id,
        estimatedInputTokens: 20_000,
        context,
        now: new Date(),
      });
      if (!start.started) return;
      await runAiTurn({
        store: options.store,
        provider,
        tool: options.tool,
        turn,
        messages,
        context,
        parentSignal,
        onEvent,
        safety: Object.freeze({
          denialCode: start.denialCode,
          inputRedactions: turn.inputRedactions,
          inputMicrosPerMillion: start.inputMicrosPerMillion,
          outputMicrosPerMillion: start.outputMicrosPerMillion,
        }),
      });
    },
  });
}
