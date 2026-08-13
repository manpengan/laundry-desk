import { z } from "zod";

export const AI_PROMPT_MAX_CHARS = 8_000;
export const AI_TURN_MAX_OUTPUT_TOKENS = 1_024;
export const AI_EVENT_REPLAY_MAX = 256;

export const AiConversationIdSchema = z.uuid();
export const AiTurnIdSchema = z.uuid();
export const AiTurnIdempotencyKeySchema = z.uuid();
export const AiEventCursorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const AiSessionStatusSchema = z.enum([
  "open",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const AiTurnStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export const AiSessionCreateRequestSchema = z.object({}).strict();
export const AiTurnCreateRequestSchema = z
  .object({
    idempotency_key: AiTurnIdempotencyKeySchema,
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(AI_PROMPT_MAX_CHARS)
      .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)),
    max_output_tokens: z.number().int().min(1).max(AI_TURN_MAX_OUTPUT_TOKENS).default(512),
  })
  .strict();

export const AiSessionViewSchema = z
  .object({
    session_id: AiConversationIdSchema,
    status: AiSessionStatusSchema,
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiTurnViewSchema = z
  .object({
    turn_id: AiTurnIdSchema,
    session_id: AiConversationIdSchema,
    status: AiTurnStatusSchema,
    stream_url: z.string().startsWith("/api/v2/ai/sessions/").max(256),
    replayed: z.boolean(),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AiSessionCreateResponseSchema = z
  .object({ ok: z.literal(true), data: AiSessionViewSchema })
  .strict();
export const AiTurnCreateResponseSchema = z
  .object({ ok: z.literal(true), data: AiTurnViewSchema })
  .strict();

const EventBaseSchema = z.object({
  cursor: AiEventCursorSchema,
  turn_id: AiTurnIdSchema,
  at: z.iso.datetime({ offset: true }),
});

export const AiStreamEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("content_delta"),
    text: z.string().min(1).max(4_096),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("tool_call"),
    tool: z.literal("synthetic.lookup"),
    step: z.number().int().min(1).max(4),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("tool_result"),
    tool: z.literal("synthetic.lookup"),
    step: z.number().int().min(1).max(4),
    outcome: z.enum(["succeeded", "failed", "timed_out", "cancelled"]),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("done"),
    finish_reason: z.enum(["stop", "limit"]),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).strict(),
  EventBaseSchema.extend({
    type: z.literal("error"),
    code: z.enum([
      "AI_UNAVAILABLE",
      "AI_ABORTED",
      "AI_DEADLINE_EXCEEDED",
      "AI_OUTPUT_LIMIT",
      "AI_TOOL_LIMIT",
      "AI_TOOL_TIMEOUT",
      "AI_PROVIDER_FAILED",
    ]),
  }).strict(),
]);

export const AiEventReplayQuerySchema = z
  .object({
    after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    limit: z.coerce.number().int().min(1).max(AI_EVENT_REPLAY_MAX).default(128),
  })
  .strict();
export const AiEventReplayResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        session: AiSessionViewSchema,
        events: z.array(AiStreamEventSchema).max(AI_EVENT_REPLAY_MAX),
        next_cursor: AiEventCursorSchema,
      })
      .strict(),
  })
  .strict();

type AiStreamingOperationRow = Readonly<{
  operation: "session_create" | "turn_create" | "events_replay" | "events_stream";
  method: "GET" | "POST";
  path: string;
  permission: "ai_use";
  csrf: boolean;
  provider_network: false;
}>;

/** Dedicated HTTP surface: never projected into the business tool registry. */
export const AI_STREAMING_OPERATION_MATRIX = Object.freeze([
  Object.freeze({
    operation: "session_create" as const,
    method: "POST" as const,
    path: "/api/v2/ai/sessions" as const,
    permission: "ai_use" as const,
    csrf: true,
    provider_network: false,
  }),
  Object.freeze({
    operation: "turn_create" as const,
    method: "POST" as const,
    path: "/api/v2/ai/sessions/{session_id}/turns" as const,
    permission: "ai_use" as const,
    csrf: true,
    provider_network: false,
  }),
  Object.freeze({
    operation: "events_replay" as const,
    method: "GET" as const,
    path: "/api/v2/ai/sessions/{session_id}/events" as const,
    permission: "ai_use" as const,
    csrf: false,
    provider_network: false,
  }),
  Object.freeze({
    operation: "events_stream" as const,
    method: "GET" as const,
    path: "/api/v2/ai/sessions/{session_id}/stream" as const,
    permission: "ai_use" as const,
    csrf: false,
    provider_network: false,
  }),
] as const satisfies readonly AiStreamingOperationRow[]);

export type AiSessionView = Readonly<z.output<typeof AiSessionViewSchema>>;
export type AiTurnView = Readonly<z.output<typeof AiTurnViewSchema>>;
export type AiTurnCreateRequest = Readonly<z.output<typeof AiTurnCreateRequestSchema>>;
export type AiStreamEvent = Readonly<z.output<typeof AiStreamEventSchema>>;
export type AiEventReplayQuery = Readonly<z.output<typeof AiEventReplayQuerySchema>>;
