import { z } from "zod";

import {
  AI_APPROVAL_OPERATION_MATRIX,
  AiApprovalDecisionSchema,
  AiApprovalDenialSchema,
  AiApprovalExecutionResponseSchema,
  AiApprovalItemResponseSchema,
  AiApprovalListResponseSchema,
  AiApprovalRequestSchema,
} from "../ai/approval.js";
import { CSRF_HEADER_NAME } from "../auth/csrf.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Schema = Readonly<Record<string, Json>>;
type Operation = Readonly<Record<string, Json>>;

export type ApprovalOpenApiProjection = Readonly<{
  schemas: Readonly<Record<string, Schema>>;
  paths: Readonly<Record<string, Readonly<{ get?: Operation; post?: Operation }>>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new TypeError("Approval OpenAPI value is not JSON serializable");
}

function schemaOf(schema: z.ZodType): Schema {
  const raw = z.toJSONSchema(schema, { target: "openapi-3.1" });
  if (!isRecord(raw)) throw new TypeError("Approval schema projection failed");
  const rest = { ...raw };
  Reflect.deleteProperty(rest, "$schema");
  return sortKeys(rest) as Schema;
}

const ref = (name: string): Schema => Object.freeze({ $ref: `#/components/schemas/${name}` });

function requestSchema(operation: (typeof AI_APPROVAL_OPERATION_MATRIX)[number]["operation"]) {
  if (operation === "submit") return "AiApprovalRequest";
  if (operation === "approve") return "AiApprovalDecision";
  if (operation === "deny") return "AiApprovalDenial";
  return null;
}

function responseSchema(operation: (typeof AI_APPROVAL_OPERATION_MATRIX)[number]["operation"]) {
  if (operation === "list") return "AiApprovalListResponse";
  if (operation === "approve") return "AiApprovalExecutionResponse";
  return "AiApprovalItemResponse";
}

function parameters(row: (typeof AI_APPROVAL_OPERATION_MATRIX)[number]): readonly Json[] {
  const values: Json[] = [...row.path.matchAll(/\{([^}]+)\}/gu)].map((match) =>
    Object.freeze({
      name: match[1]!,
      in: "path",
      required: true,
      schema: Object.freeze({ type: "string", format: "uuid" }),
    }),
  );
  if (row.operation === "list") {
    values.push(
      Object.freeze({
        name: "status",
        in: "query",
        required: false,
        schema: Object.freeze({ type: "string", enum: Object.freeze(["pending", "history"]) }),
      }),
      Object.freeze({
        name: "limit",
        in: "query",
        required: false,
        schema: Object.freeze({ type: "integer", minimum: 1, maximum: 100, default: 50 }),
      }),
    );
  }
  if (row.csrf) {
    values.push(
      Object.freeze({
        name: CSRF_HEADER_NAME,
        in: "header",
        required: true,
        schema: Object.freeze({ type: "string", pattern: "^v1\\.[A-Za-z0-9_-]{43,128}$" }),
      }),
    );
  }
  return Object.freeze(values);
}

function operation(row: (typeof AI_APPROVAL_OPERATION_MATRIX)[number]): Operation {
  const input = requestSchema(row.operation);
  const params = parameters(row);
  return Object.freeze({
    operationId: `ai_approval_${row.operation}`,
    summary: `AI approval ${row.operation}`,
    description:
      "Tenant/store-scoped R4 approval bound to server-frozen args, versions, idempotency and expiry. R5 is excluded.",
    tags: Object.freeze(["ai-approval"]),
    ...(params.length === 0 ? {} : { parameters: params }),
    ...(input === null
      ? {}
      : {
          requestBody: Object.freeze({
            required: true,
            content: Object.freeze({
              "application/json": Object.freeze({ schema: ref(input) }),
            }),
          }),
        }),
    responses: Object.freeze({
      "200": Object.freeze({
        description: "Successful approval operation",
        content: Object.freeze({
          "application/json": Object.freeze({ schema: ref(responseSchema(row.operation)) }),
        }),
      }),
      "403": Object.freeze({ description: "Approval authority denied" }),
      "409": Object.freeze({ description: "Frozen authority or version changed" }),
      "429": Object.freeze({ description: "Approval rate limit exceeded" }),
    }),
    security: Object.freeze([
      Object.freeze({
        bearerAuth: Object.freeze([]),
        ...(row.csrf ? { csrfHeader: Object.freeze([]) } : {}),
      }),
    ]),
    "x-laundry-kind": "auth",
    "x-laundry-risk": row.risk,
    "x-laundry-classification": "pii",
    "x-laundry-offline-mode": "forbidden",
    "x-laundry-version": "1.0.0",
  }) as Operation;
}

export function buildApprovalOpenApiProjection(): ApprovalOpenApiProjection {
  const paths: Record<string, Readonly<{ get?: Operation; post?: Operation }>> = {};
  for (const row of AI_APPROVAL_OPERATION_MATRIX) {
    paths[row.path] = Object.freeze({
      ...(paths[row.path] ?? {}),
      [row.method === "GET" ? "get" : "post"]: operation(row),
    });
  }
  return Object.freeze({
    schemas: Object.freeze({
      AiApprovalRequest: schemaOf(AiApprovalRequestSchema),
      AiApprovalDecision: schemaOf(AiApprovalDecisionSchema),
      AiApprovalDenial: schemaOf(AiApprovalDenialSchema),
      AiApprovalItemResponse: schemaOf(AiApprovalItemResponseSchema),
      AiApprovalListResponse: schemaOf(AiApprovalListResponseSchema),
      AiApprovalExecutionResponse: schemaOf(AiApprovalExecutionResponseSchema),
    }),
    paths: Object.freeze(paths),
  });
}
