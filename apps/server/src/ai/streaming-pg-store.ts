import { AiStreamEventSchema, type AiSessionView, type AiStreamEvent } from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";
import { createPgAiSafetyMethods } from "./safety-pg-store.js";
import { withAiContext } from "./streaming-pg-context.js";
import {
  AiStoreError,
  type AiConversationStore,
  type AiEventDraft,
  type AiTurnRecord,
} from "./streaming-store.js";

type SessionRow = Readonly<{
  id: string;
  status: AiSessionView["status"];
  created_at: Date;
  updated_at: Date;
}>;

type TurnRow = Readonly<{
  id: string;
  ai_session_id: string;
  idempotency_key: string;
  prompt: string;
  prompt_sha256: string;
  max_output_tokens: number;
  input_redactions: number;
  status: AiTurnRecord["status"];
  created_at: Date;
}>;

type EventRow = Readonly<{
  cursor: string | number;
  turn_id: string;
  event_type: AiStreamEvent["type"];
  text_delta: string | null;
  tool_name: "synthetic.lookup" | null;
  tool_step: number | null;
  tool_outcome: "succeeded" | "failed" | "timed_out" | "cancelled" | null;
  finish_reason: "stop" | "limit" | null;
  error_code: Extract<AiStreamEvent, { type: "error" }>["code"] | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: Date;
}>;

function viewFromRow(row: SessionRow): AiSessionView {
  return Object.freeze({
    session_id: row.id,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  });
}

function turnFromRow(row: TurnRow): AiTurnRecord {
  return Object.freeze({
    id: row.id,
    sessionId: row.ai_session_id,
    idempotencyKey: row.idempotency_key,
    prompt: row.prompt,
    promptSha256: row.prompt_sha256,
    maxOutputTokens: row.max_output_tokens,
    inputRedactions: row.input_redactions,
    status: row.status,
    createdAt: new Date(row.created_at),
  });
}

function eventFromRow(row: EventRow): AiStreamEvent {
  const base = {
    cursor: Number(row.cursor),
    turn_id: row.turn_id,
    at: row.created_at.toISOString(),
  };
  if (row.event_type === "content_delta") {
    return AiStreamEventSchema.parse({ ...base, type: row.event_type, text: row.text_delta });
  }
  if (row.event_type === "tool_call") {
    return AiStreamEventSchema.parse({
      ...base,
      type: row.event_type,
      tool: row.tool_name,
      step: row.tool_step,
    });
  }
  if (row.event_type === "tool_result") {
    return AiStreamEventSchema.parse({
      ...base,
      type: row.event_type,
      tool: row.tool_name,
      step: row.tool_step,
      outcome: row.tool_outcome,
    });
  }
  if (row.event_type === "done") {
    return AiStreamEventSchema.parse({
      ...base,
      type: row.event_type,
      finish_reason: row.finish_reason,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
    });
  }
  return AiStreamEventSchema.parse({ ...base, type: "error", code: row.error_code });
}

function eventParams(event: AiEventDraft): readonly unknown[] {
  return Object.freeze([
    event.type,
    event.type === "content_delta" ? event.text : null,
    event.type === "tool_call" || event.type === "tool_result" ? event.tool : null,
    event.type === "tool_call" || event.type === "tool_result" ? event.step : null,
    event.type === "tool_result" ? event.outcome : null,
    event.type === "done" ? event.finish_reason : null,
    event.type === "error" ? event.code : null,
    event.type === "done" ? event.input_tokens : null,
    event.type === "done" ? event.output_tokens : null,
  ]);
}

function translateStoreError(error: unknown): never {
  if (typeof error === "object" && error !== null) {
    const code = Reflect.get(error, "code");
    const message = Reflect.get(error, "message");
    if (code === "23505") throw new AiStoreError("IDEMPOTENCY_CONFLICT");
    if (code === "40001") throw new AiStoreError("ACTIVE_TURN");
    if (code === "55000" || code === "42501") throw new AiStoreError("NOT_FOUND");
    if (message === "AI session already has an active turn") throw new AiStoreError("ACTIVE_TURN");
  }
  throw error;
}

const EVENT_COLUMNS = `cursor, turn_id::text, event_type, text_delta, tool_name,
  tool_step, tool_outcome, finish_reason, error_code, input_tokens, output_tokens, created_at`;

export function createPgAiConversationStore(pool: PgPool): AiConversationStore {
  return Object.freeze({
    createSession: async (input) => {
      try {
        return await withAiContext(pool, input.context, async (client) => {
          await client.query("SELECT public.ai_session_create($1::uuid, $2::uuid, $3::uuid)", [
            input.id,
            input.context.authSessionId,
            input.auditId,
          ]);
          const result = await client.query<SessionRow>(
            `SELECT id::text, status, created_at, updated_at FROM public.ai_sessions
              WHERE id = $1::uuid AND auth_session_id = $2::uuid`,
            [input.id, input.context.authSessionId],
          );
          const row = result.rows[0];
          if (row === undefined) throw new AiStoreError("NOT_FOUND");
          return viewFromRow(row);
        });
      } catch (error) {
        return translateStoreError(error);
      }
    },

    createTurn: async (input) => {
      try {
        return await withAiContext(pool, input.context, async (client) => {
          const created = await client.query<
            Readonly<{
              turn_id: string;
              replayed: boolean;
            }>
          >(
            `SELECT turn_id::text, replayed FROM public.ai_turn_create_safe(
              $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::char(64), $7,
              $8::uuid, $9::uuid, $10
            )`,
            [
              input.id,
              input.sessionId,
              input.context.authSessionId,
              input.idempotencyKey,
              input.prompt,
              input.promptSha256,
              input.maxOutputTokens,
              input.messageId,
              input.auditId,
              input.inputRedactions,
            ],
          );
          const createdRow = created.rows[0];
          if (createdRow === undefined) throw new AiStoreError("INVALID_STATE");
          const selected = await client.query<TurnRow>(
            `SELECT turn_value.id::text, turn_value.ai_session_id::text,
                    turn_value.idempotency_key::text, message.content AS prompt,
                    turn_value.prompt_sha256, turn_value.max_output_tokens,
                    turn_value.input_redactions,
                    turn_value.status, turn_value.created_at
               FROM public.ai_turns turn_value
               JOIN public.ai_messages message ON message.turn_id = turn_value.id
                AND message.role = 'user'
              WHERE turn_value.id = $1::uuid AND turn_value.auth_session_id = $2::uuid`,
            [createdRow.turn_id, input.context.authSessionId],
          );
          const row = selected.rows[0];
          if (row === undefined) throw new AiStoreError("NOT_FOUND");
          return Object.freeze({ turn: turnFromRow(row), replayed: createdRow.replayed });
        });
      } catch (error) {
        return translateStoreError(error);
      }
    },

    getSession: async (sessionId, context) =>
      withAiContext(
        pool,
        context,
        async (client) => {
          const result = await client.query<SessionRow>(
            `SELECT id::text, status, created_at, updated_at FROM public.ai_sessions
              WHERE id = $1::uuid AND auth_session_id = $2::uuid`,
            [sessionId, context.authSessionId],
          );
          return result.rows[0] === undefined ? null : viewFromRow(result.rows[0]);
        },
        true,
      ),

    getQueuedTurn: async (sessionId, context) =>
      withAiContext(
        pool,
        context,
        async (client) => {
          const result = await client.query<TurnRow>(
            `SELECT turn_value.id::text, turn_value.ai_session_id::text,
                    turn_value.idempotency_key::text, message.content AS prompt,
                    turn_value.prompt_sha256, turn_value.max_output_tokens,
                    turn_value.input_redactions,
                    turn_value.status, turn_value.created_at
               FROM public.ai_turns turn_value
               JOIN public.ai_messages message ON message.turn_id = turn_value.id
                AND message.role = 'user'
              WHERE turn_value.ai_session_id = $1::uuid
                AND turn_value.auth_session_id = $2::uuid AND turn_value.status = 'queued'
              LIMIT 1`,
            [sessionId, context.authSessionId],
          );
          return result.rows[0] === undefined ? null : turnFromRow(result.rows[0]);
        },
        true,
      ),

    appendEvent: async (input) =>
      withAiContext(pool, input.context, async (client) => {
        const params = eventParams(input.event);
        const result = await client.query<Readonly<{ cursor: string }>>(
          `SELECT public.ai_stream_event_append(
            $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12
          )::text AS cursor`,
          [input.id, input.turnId, input.context.authSessionId, ...params],
        );
        const cursor = result.rows[0]?.cursor;
        if (cursor === undefined) throw new AiStoreError("INVALID_STATE");
        const selected = await client.query<EventRow>(
          `SELECT ${EVENT_COLUMNS} FROM public.ai_stream_events
            WHERE ai_session_id = (SELECT ai_session_id FROM public.ai_turns WHERE id = $1::uuid)
              AND cursor = $2::bigint AND auth_session_id = $3::uuid`,
          [input.turnId, cursor, input.context.authSessionId],
        );
        const row = selected.rows[0];
        if (row === undefined) throw new AiStoreError("NOT_FOUND");
        return eventFromRow(row);
      }),

    appendToolAttempt: async (input) =>
      withAiContext(pool, input.context, async (client) => {
        await client.query(
          `SELECT public.ai_tool_attempt_append(
            $1::uuid, $2::uuid, $3::uuid, $4, $5::char(64), $6::char(64), $7, $8
          )`,
          [
            input.attempt.id,
            input.attempt.turnId,
            input.context.authSessionId,
            input.attempt.step,
            input.attempt.requestSha256,
            input.attempt.resultSha256,
            input.attempt.outcome,
            input.attempt.durationMs,
          ],
        );
      }),

    listEvents: async (sessionId, after, limit, context) =>
      withAiContext(
        pool,
        context,
        async (client) => {
          const result = await client.query<EventRow>(
            `SELECT ${EVENT_COLUMNS} FROM public.ai_stream_events
              WHERE ai_session_id = $1::uuid AND auth_session_id = $2::uuid AND cursor > $3
              ORDER BY cursor LIMIT $4`,
            [sessionId, context.authSessionId, after, limit],
          );
          return Object.freeze(result.rows.map(eventFromRow));
        },
        true,
      ),

    listMessages: async (sessionId, context) =>
      withAiContext(
        pool,
        context,
        async (client) => {
          const result = await client.query<
            Readonly<{ role: "user" | "assistant"; content: string }>
          >(
            `SELECT role, content FROM public.ai_messages
              WHERE ai_session_id = $1::uuid AND auth_session_id = $2::uuid
              ORDER BY sequence LIMIT 100`,
            [sessionId, context.authSessionId],
          );
          return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
        },
        true,
      ),

    ...createPgAiSafetyMethods(pool),
  });
}
