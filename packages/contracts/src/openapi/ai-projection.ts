import {
  AI_STREAMING_OPERATION_MATRIX,
  AiEventReplayResponseSchema,
  AiSessionCreateRequestSchema,
  AiSessionCreateResponseSchema,
  AiStreamEventSchema,
  AiTurnCreateRequestSchema,
  AiTurnCreateResponseSchema,
} from "../ai/streaming.js";
import { AiOperationConfirmSchema, AiOperationResponseSchema } from "../ai/operations.js";
import {
  AiVisionRequestSchema,
  AiVisionResponseSchema,
  AiVisionCandidateQuerySchema,
  AiVisionCandidatesResponseSchema,
} from "../ai/vision.js";
import { AiSafetyStatusResponseSchema } from "../ai/safety.js";
import {
  AiRuntimeConfigRequestSchema,
  AiRuntimeConfigResponseSchema,
} from "../ai/runtime-config.js";
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
      "Provider-neutral, authenticated, hard-off-by-default AI streaming surface. The finite server registry exposes analysis, masked lookup and R3 operation previews; only a separate human confirmation endpoint can execute. No free SQL, URL, header, credential or provider escape hatch.",
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
    AiVisionRequest: toSchema(AiVisionRequestSchema),
    AiVisionResponse: toSchema(AiVisionResponseSchema),
    AiVisionCandidateQuery: toSchema(AiVisionCandidateQuerySchema),
    AiVisionCandidatesResponse: toSchema(AiVisionCandidatesResponseSchema),
    AiOperationConfirm: toSchema(AiOperationConfirmSchema),
    AiOperationResponse: toSchema(AiOperationResponseSchema),
    AiAssistantToolCall: toSchema(AiAssistantToolCallSchema),
    AiAssistantToolResult: toSchema(AiAssistantToolResultSchema),
    AiEventReplayResponse: toSchema(AiEventReplayResponseSchema),
    AiSafetyStatusResponse: toSchema(AiSafetyStatusResponseSchema),
    AiRuntimeConfigRequest: toSchema(AiRuntimeConfigRequestSchema),
    AiRuntimeConfigResponse: toSchema(AiRuntimeConfigResponseSchema),
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
  for (const [name, input, output] of [
    ["analyze", "AiVisionRequest", "AiVisionResponse"],
    ["candidates", "AiVisionCandidateQuery", "AiVisionCandidatesResponse"],
  ] as const) {
    paths[`/api/v2/ai/vision/${name}`] = {
      post: {
        operationId: `ai_vision_${name}`,
        summary: `Bounded garment vision ${name}`,
        description:
          "Current local tenant, ai_use and order_write only. Candidate lookup is local. Analysis requires explicit outgoing consent; images are re-encoded without metadata, at most two candidate hashes are rechecked, model output is advisory only. Existing AI budget, credentials and cancellation apply.",
        tags: ["ai"],
        parameters: [csrfHeader()],
        requestBody: {
          required: true,
          content: { "application/json": jsonContent(schemaRef(input)) },
        },
        responses: {
          "200": successSchemaResponse(output, "Bounded advisory response"),
          default: failureResponse("Permission, photo, budget or provider failure"),
        },
        security: [{ bearerAuth: [], csrfHeader: [] }],
        "x-laundry-kind": "ai",
        "x-laundry-risk": "R0",
        "x-laundry-classification": "confidential",
      },
    };
  }
  for (const row of AI_STREAMING_OPERATION_MATRIX) {
    const operation = buildAiOperation(row);
    paths[row.path] = Object.freeze(
      row.method === "POST" ? { post: operation } : { get: operation },
    );
  }
  for (const row of AI_PROVIDER_OPERATION_MATRIX) {
    paths[row.path] = Object.freeze({ post: buildProviderOperation(row) });
  }
  paths["/api/v2/ai/runtime-config"] = Object.freeze({
    get: runtimeConfigOperation(false),
    post: runtimeConfigOperation(true),
  });
  paths["/api/v2/ai/operations/confirm"] = Object.freeze({
    post: Object.freeze({
      operationId: "ai_operation_confirm",
      summary: "Confirm a frozen, bounded assistant operation",
      description:
        "Human confirmation only. Revalidates the session, R3 command allowlist, original creator, tenant, permissions and frozen business authority. No model execution capability or automatic messages.",
      tags: Object.freeze(["ai"]),
      parameters: Object.freeze([csrfHeader()]),
      requestBody: Object.freeze({
        required: true as const,
        content: Object.freeze({
          "application/json": jsonContent(schemaRef("AiOperationConfirm")),
        }),
      }),
      responses: Object.freeze({
        "200": successSchemaResponse("AiOperationResponse", "Confirmed operation"),
        default: failureResponse("Permission, expiry, state or input failure"),
      }),
      security: Object.freeze([
        Object.freeze({ bearerAuth: Object.freeze([]), csrfHeader: Object.freeze([]) }),
      ]),
      "x-laundry-kind": "ai" as const,
      "x-laundry-risk": "R3" as const,
      "x-laundry-classification": "confidential" as const,
    }),
  });
  return Object.freeze({ paths, schemas });
}

function runtimeConfigOperation(write: boolean): OpenApiOperation {
  return Object.freeze({
    operationId: write ? "ai_runtime_configure" : "ai_runtime_config_get",
    summary: write ? "Configure the local AI provider and budget" : "Read local AI configuration",
    description:
      "Admin-only organization settings. No credentials are returned. Enabling validates the selected model with the fixed provider host; version CAS and audit are atomic.",
    tags: Object.freeze(["ai-provider"]),
    parameters: Object.freeze(write ? [csrfHeader()] : []),
    ...(write
      ? {
          requestBody: Object.freeze({
            required: true as const,
            content: Object.freeze({
              "application/json": jsonContent(schemaRef("AiRuntimeConfigRequest")),
            }),
          }),
        }
      : {}),
    responses: Object.freeze({
      "200": successSchemaResponse("AiRuntimeConfigResponse", "Current AI configuration"),
      "401": failureResponse("Authentication failed"),
      "403": failureResponse("Permission or CSRF denied"),
      "409": failureResponse("Configuration version or provider unavailable"),
      "429": failureResponse("Rate limit exceeded"),
      default: failureResponse("Unified failure envelope"),
    }),
    security: Object.freeze([
      Object.freeze({
        bearerAuth: Object.freeze([]),
        ...(write ? { csrfHeader: Object.freeze([]) } : {}),
      }),
    ]),
    "x-laundry-kind": "ai" as const,
    "x-laundry-risk": write ? "R3" : "R0",
    "x-laundry-classification": "confidential" as const,
  });
}
import type { z } from "zod";

import { CSRF_HEADER_NAME } from "../auth/csrf.js";
