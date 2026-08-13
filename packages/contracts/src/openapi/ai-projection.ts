import {
  AI_STREAMING_OPERATION_MATRIX,
  AiEventReplayResponseSchema,
  AiSessionCreateRequestSchema,
  AiSessionCreateResponseSchema,
  AiStreamEventSchema,
  AiTurnCreateRequestSchema,
  AiTurnCreateResponseSchema,
} from "../ai/streaming.js";
import { AiSafetyStatusResponseSchema } from "../ai/safety.js";
import {
  AI_PROVIDER_OPERATION_MATRIX,
  AiProviderValidateRequestSchema,
  AiProviderValidationIntentRequestSchema,
  AiProviderValidationIntentResponseSchema,
  AiProviderValidationResponseSchema,
} from "../ai/provider-connections.js";
import { AiAssistantToolCallSchema, AiAssistantToolResultSchema } from "../ai/assistant.js";
import type {
  OpenApiMediaType,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiResponse,
  OpenApiSchemaObject,
} from "./build-document.js";

type SchemaConverter = (schema: z.ZodType) => OpenApiSchemaObject;

const schemaRef = (schemaId: string): OpenApiSchemaObject =>
  Object.freeze({ $ref: `#/components/schemas/${schemaId}` });

const jsonContent = (schema: OpenApiSchemaObject): OpenApiMediaType =>
  Object.freeze({ schema: Object.freeze(schema) });

const failureResponse = (description: string): OpenApiResponse =>
  Object.freeze({
    description,
    content: Object.freeze({
      "application/json": jsonContent(schemaRef("CommandFailureResponse")),
    }),
  });

const successSchemaResponse = (schemaId: string, description: string): OpenApiResponse =>
  Object.freeze({
    description,
    content: Object.freeze({
      "application/json": jsonContent(schemaRef(schemaId)),
    }),
  });

const pathParameters = (path: string): OpenApiParameter[] =>
  [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) =>
    Object.freeze({
      name: match[1]!,
      in: "path" as const,
      required: true,
      schema: Object.freeze({ type: "string", format: "uuid" }),
    }),
  );

const csrfHeader = (): OpenApiParameter =>
  Object.freeze({
    name: CSRF_HEADER_NAME,
    in: "header" as const,
    required: true,
    description: "Double-submit CSRF proof; must match the readable CSRF cookie value.",
    schema: Object.freeze({ type: "string", pattern: "^v1\\.[A-Za-z0-9_-]{43,128}$" }),
  });

const requestSchemaId = (operation: string): string | null =>
  operation === "session_create"
    ? "AiSessionCreateRequest"
    : operation === "turn_create"
      ? "AiTurnCreateRequest"
      : null;

const responseSchemaId = (operation: string): string | null =>
  operation === "session_create"
    ? "AiSessionCreateResponse"
    : operation === "turn_create"
      ? "AiTurnCreateResponse"
      : operation === "safety_status"
        ? "AiSafetyStatusResponse"
        : operation === "events_replay"
          ? "AiEventReplayResponse"
          : null;

function operationParameters(
  row: (typeof AI_STREAMING_OPERATION_MATRIX)[number],
): OpenApiParameter[] {
  const parameters = pathParameters(row.path);
  if (row.csrf) parameters.push(csrfHeader());
  if (row.operation === "events_replay") {
    parameters.push(
      Object.freeze({
        name: "after",
        in: "query" as const,
        required: false,
        schema: Object.freeze({ type: "integer", minimum: 0, default: 0 }),
      }),
      Object.freeze({
        name: "limit",
        in: "query" as const,
        required: false,
        schema: Object.freeze({ type: "integer", minimum: 1, maximum: 256, default: 128 }),
      }),
    );
  }
  if (row.operation === "events_stream") {
    parameters.push(
      Object.freeze({
        name: "Last-Event-ID",
        in: "header" as const,
        required: false,
        description: "Durable cursor; replay is bounded to 256 persisted events.",
        schema: Object.freeze({ type: "integer", minimum: 0 }),
      }),
    );
  }
  return parameters;
}

function buildAiOperation(row: (typeof AI_STREAMING_OPERATION_MATRIX)[number]): OpenApiOperation {
  const requestSchema = requestSchemaId(row.operation);
  const responseSchema = responseSchemaId(row.operation);
  const parameters = operationParameters(row);
  const success =
    responseSchema === null
      ? Object.freeze({
          description: "Bounded SSE stream of persisted AI events",
          content: Object.freeze({
            "text/event-stream": jsonContent(
              Object.freeze({
                type: "string",
                description: "SSE frames carrying AiStreamEvent JSON",
              }),
            ),
          }),
        })
      : successSchemaResponse(responseSchema, "Successful AI operation");
  return Object.freeze({
    operationId: `ai_${row.operation}`,
    summary: `AI ${row.operation}`,
    description:
      "Provider-neutral, authenticated, hard-off-by-default AI streaming surface. Item 15 exposes only business.summary, records.search, and procedure.troubleshoot through the server registry; no write, free SQL, URL, header, credential, or provider escape hatch.",
    tags: Object.freeze(["ai"]),
    ...(parameters.length === 0 ? {} : { parameters: Object.freeze(parameters) }),
    ...(requestSchema === null
      ? {}
      : {
          requestBody: Object.freeze({
            required: true as const,
            content: Object.freeze({
              "application/json": jsonContent(schemaRef(requestSchema)),
            }),
          }),
        }),
    responses: Object.freeze({
      "200": success,
      ...(row.operation === "session_create" ? { "201": success } : {}),
      ...(row.operation === "turn_create" ? { "202": success } : {}),
      "401": failureResponse("Authentication failed"),
      "403": failureResponse("Permission denied"),
      "409": failureResponse("Active turn or idempotency conflict"),
      "503": failureResponse("AI is not configured"),
      default: failureResponse("Unified failure envelope"),
    }),
    security: Object.freeze([
      Object.freeze({
        bearerAuth: Object.freeze([]),
        ...(row.csrf ? { csrfHeader: Object.freeze([]) } : {}),
      }),
    ]),
    "x-laundry-kind": "ai" as const,
    "x-laundry-risk": "R0",
    "x-laundry-classification": "confidential",
  });
}

function buildProviderOperation(
  row: (typeof AI_PROVIDER_OPERATION_MATRIX)[number],
): OpenApiOperation {
  const intent = row.operation === "validation_intent";
  const request = intent ? "AiProviderValidationIntentRequest" : "AiProviderValidateRequest";
  const response = intent ? "AiProviderValidationIntentResponse" : "AiProviderValidationResponse";
  return Object.freeze({
    operationId: `ai_provider_${row.operation}`,
    summary: `AI provider ${row.operation}`,
    description:
      "Admin-only, CSRF-protected, rate-limited provider validation. Credential plaintext is never returned.",
    tags: Object.freeze(["ai-provider"]),
    parameters: Object.freeze([csrfHeader()]),
    requestBody: Object.freeze({
      required: true as const,
      content: Object.freeze({
        "application/json": jsonContent(schemaRef(request)),
      }),
    }),
    responses: Object.freeze({
      "200": successSchemaResponse(response, "Provider validation operation completed"),
      "401": failureResponse("Authentication failed"),
      "403": failureResponse("Permission or frozen confirmation denied"),
      "409": failureResponse("Feature, credential, or version unavailable"),
      "429": failureResponse("Dedicated provider validation rate limit exceeded"),
      default: failureResponse("Unified failure envelope"),
    }),
    security: Object.freeze([
      Object.freeze({ bearerAuth: Object.freeze([]), csrfHeader: Object.freeze([]) }),
    ]),
    "x-laundry-kind": "ai" as const,
    "x-laundry-risk": row.risk,
    "x-laundry-classification": "secret" as const,
  });
}

export function collectAiOpenApiProjection(toSchema: SchemaConverter): Readonly<{
  paths: Record<string, OpenApiPathItem>;
  schemas: Record<string, OpenApiSchemaObject>;
}> {
  const schemas = {
    AiAssistantToolCall: toSchema(AiAssistantToolCallSchema),
    AiAssistantToolResult: toSchema(AiAssistantToolResultSchema),
    AiEventReplayResponse: toSchema(AiEventReplayResponseSchema),
    AiSafetyStatusResponse: toSchema(AiSafetyStatusResponseSchema),
    AiSessionCreateRequest: toSchema(AiSessionCreateRequestSchema),
    AiSessionCreateResponse: toSchema(AiSessionCreateResponseSchema),
    AiStreamEvent: toSchema(AiStreamEventSchema),
    AiTurnCreateRequest: toSchema(AiTurnCreateRequestSchema),
    AiTurnCreateResponse: toSchema(AiTurnCreateResponseSchema),
    AiProviderValidateRequest: toSchema(AiProviderValidateRequestSchema),
    AiProviderValidationIntentRequest: toSchema(AiProviderValidationIntentRequestSchema),
    AiProviderValidationIntentResponse: toSchema(AiProviderValidationIntentResponseSchema),
    AiProviderValidationResponse: toSchema(AiProviderValidationResponseSchema),
  };
  const paths: Record<string, OpenApiPathItem> = {};
  for (const row of AI_STREAMING_OPERATION_MATRIX) {
    const operation = buildAiOperation(row);
    paths[row.path] = Object.freeze(
      row.method === "POST" ? { post: operation } : { get: operation },
    );
  }
  for (const row of AI_PROVIDER_OPERATION_MATRIX) {
    paths[row.path] = Object.freeze({ post: buildProviderOperation(row) });
  }
  return Object.freeze({ paths, schemas });
}
import type { z } from "zod";

import { CSRF_HEADER_NAME } from "../auth/csrf.js";
