import { z } from "zod";

import { CSRF_HEADER_NAME } from "../auth/csrf.js";
import { AUTH_OPERATION_MATRIX, type AuthOperationDescriptor } from "../auth/operations.js";
import { M1_FIRST_WAVE_DEFINITIONS, M2_CONTRACT_DEFINITIONS } from "../commands/catalog.js";
import {
  CommandErrorSchema,
  CommandResponseSchema,
  createCommandError,
} from "../envelope/responses.js";
import type { CommandDefinition, QueryDefinition } from "../registry/definitions.js";
import {
  CUSTOMER_PORTAL_AUTH_PATHS,
  CUSTOMER_PORTAL_AUTH_SCHEMAS,
  CUSTOMER_PORTAL_OPENAPI,
} from "./customer-portal-security.js";

/** OpenAPI document version field (must stay 3.1.x for A7). */
export const OPENAPI_VERSION = "3.1.0" as const;

/** Contract package API surface version projected into info.version (no timestamps). */
export const OPENAPI_INFO_VERSION = "0.3.0" as const;

/** Path of the committed snapshot relative to packages/contracts. */
export const OPENAPI_SNAPSHOT_RELATIVE_PATH = "openapi/laundry-v2.openapi.json" as const;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type OpenApiSchemaObject = { readonly [key: string]: JsonValue };

type OpenApiMediaType = Readonly<{
  schema: OpenApiSchemaObject;
}>;

type OpenApiResponse = Readonly<{
  description: string;
  content?: Readonly<{ readonly "application/json": OpenApiMediaType }>;
  headers?: Readonly<
    Record<string, Readonly<{ description: string; schema: OpenApiSchemaObject }>>
  >;
}>;

type OpenApiParameter = Readonly<{
  name: string;
  in: "header" | "path" | "query" | "cookie";
  required: boolean;
  description?: string;
  schema: OpenApiSchemaObject;
}>;

type OpenApiOperation = Readonly<{
  operationId: string;
  summary: string;
  description: string;
  tags: readonly string[];
  parameters?: readonly OpenApiParameter[];
  requestBody?: Readonly<{
    required: true;
    content: Readonly<{ readonly "application/json": OpenApiMediaType }>;
  }>;
  responses: Readonly<Record<string, OpenApiResponse>>;
  security?: readonly Readonly<Record<string, readonly string[]>>[];
  "x-laundry-risk"?: string;
  "x-laundry-classification"?: string;
  "x-laundry-offline-mode"?: string;
  "x-laundry-version"?: string;
  "x-laundry-kind"?: "command" | "query" | "auth";
}>;

type OpenApiPathItem = Readonly<{
  get?: OpenApiOperation;
  post?: OpenApiOperation;
}>;

type OpenApiSecurityScheme = Readonly<{
  type: "http" | "apiKey";
  scheme?: "bearer";
  bearerFormat?: string;
  in?: "header" | "cookie";
  name?: string;
  description?: string;
}>;

export type OpenApiDocument = Readonly<{
  openapi: typeof OPENAPI_VERSION;
  info: Readonly<{
    title: string;
    version: typeof OPENAPI_INFO_VERSION;
    description: string;
  }>;
  paths: Readonly<Record<string, OpenApiPathItem>>;
  components: Readonly<{
    schemas: Readonly<Record<string, OpenApiSchemaObject>>;
    securitySchemes: Readonly<Record<string, OpenApiSecurityScheme>>;
  }>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep-sort object keys so re-generation is byte-stable. */
export const sortKeysDeep = (value: unknown): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((entry) => sortKeysDeep(entry));
  }
  if (isRecord(value)) {
    const sorted = Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortKeysDeep(value[key])] as const);
    return Object.fromEntries(sorted);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  throw new TypeError("OpenAPI document must be JSON-serializable");
};

/** Convert a Zod schema into an OpenAPI 3.1 schema object (no $schema / timestamps). */
export const zodToOpenApiSchema = (schema: z.ZodType): OpenApiSchemaObject => {
  const raw = z.toJSONSchema(schema, { target: "openapi-3.1" });
  if (!isRecord(raw)) {
    throw new TypeError("z.toJSONSchema must return an object");
  }
  const rest: Record<string, unknown> = { ...raw };
  Reflect.deleteProperty(rest, "$schema");
  return sortKeysDeep(rest) as OpenApiSchemaObject;
};

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

const successEnvelopeResponse = (description: string): OpenApiResponse =>
  Object.freeze({
    description,
    content: Object.freeze({
      "application/json": jsonContent(schemaRef("CommandResponse")),
    }),
  });

const successSchemaResponse = (schemaId: string, description: string): OpenApiResponse =>
  Object.freeze({
    description,
    content: Object.freeze({
      "application/json": jsonContent(schemaRef(schemaId)),
    }),
  });

const CommandFailureResponseSchema = z.strictObject({
  ok: z.literal(false),
  error: CommandErrorSchema,
});

const buildEnvelopeSchemas = (): Record<string, OpenApiSchemaObject> =>
  Object.freeze({
    CommandError: zodToOpenApiSchema(CommandErrorSchema),
    CommandFailureResponse: zodToOpenApiSchema(CommandFailureResponseSchema),
    CommandResponse: zodToOpenApiSchema(CommandResponseSchema),
  });

const pathParametersFromTemplate = (path: string): readonly OpenApiParameter[] => {
  const names = [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
  return Object.freeze(
    names.map((name) =>
      Object.freeze({
        name,
        in: "path" as const,
        required: true,
        schema: Object.freeze({ type: "string", format: "uuid" }),
      }),
    ),
  );
};

const authSecurity = (
  row: AuthOperationDescriptor,
): readonly Readonly<Record<string, readonly string[]>>[] | undefined => {
  const requirements: Record<string, readonly string[]>[] = [];
  if (row.requirements.access === "active_required") {
    requirements.push({ bearerAuth: [] });
  }
  if (row.requirements.csrf === "required") {
    requirements.push({ csrfHeader: [] });
  }
  return requirements.length === 0 ? undefined : Object.freeze(requirements);
};

const authParameters = (row: AuthOperationDescriptor): readonly OpenApiParameter[] | undefined => {
  const parameters: OpenApiParameter[] = [...pathParametersFromTemplate(row.path)];
  if (row.requirements.csrf === "required") {
    parameters.push(CUSTOMER_PORTAL_OPENAPI.csrfParameter);
  }
  return parameters.length === 0 ? undefined : Object.freeze(parameters);
};

const authCommandLabel = (row: AuthOperationDescriptor): string | undefined => {
  if (!("command" in row) || row.command === undefined) return undefined;
  return `Registry command: \`${row.command}\`.`;
};

const buildAuthOperation = (row: AuthOperationDescriptor): OpenApiOperation => {
  const parameters = authParameters(row);
  const security = authSecurity(row);
  return Object.freeze({
    operationId: `auth_${row.operation}`,
    summary: `Auth ${row.operation}`,
    description: [
      `Browser auth operation \`${row.operation}\` (ingress: ${row.ingress}).`,
      authCommandLabel(row),
      `Allowed public errors: ${row.allowed_public_errors.join(", ")}.`,
      "Projection source: AUTH_OPERATION_MATRIX (A5/A7). Server-only hashes and factories are omitted.",
    ]
      .filter((part): part is string => part !== undefined)
      .join(" "),
    tags: Object.freeze(["auth"]),
    ...(parameters === undefined ? {} : { parameters }),
    requestBody: Object.freeze({
      required: true as const,
      content: Object.freeze({
        "application/json": jsonContent(schemaRef(row.request_schema_id)),
      }),
    }),
    responses: Object.freeze({
      "200": successSchemaResponse(row.response_schema_id, "Successful browser auth response"),
      "401": failureResponse(createCommandError("AUTHENTICATION_FAILED").message),
      "403": failureResponse(createCommandError("CSRF_REJECTED").message),
      "429": failureResponse(createCommandError("RATE_LIMITED").message),
      default: failureResponse("Unified A2 command failure envelope"),
    }),
    ...(security === undefined ? {} : { security }),
    "x-laundry-kind": "auth" as const,
  });
};

const registerAuthSchemas = (
  schemas: Record<string, OpenApiSchemaObject>,
  row: AuthOperationDescriptor,
): void => {
  if (schemas[row.request_schema_id] === undefined) {
    schemas[row.request_schema_id] = zodToOpenApiSchema(row.request_schema);
  }
  if (schemas[row.response_schema_id] === undefined) {
    schemas[row.response_schema_id] = zodToOpenApiSchema(row.response_schema);
  }
};

const definitionInputSchemaId = (kind: "command" | "query", name: string): string =>
  `input.${kind}.${name}`;

const busPathFor = (kind: "command" | "query", name: string): string =>
  kind === "command" ? `/v1/commands/${name}` : `/v1/queries/${name}`;

const isCustomerSelfService = (definition: { readonly name: string }): boolean =>
  definition.name.startsWith("customer.self_service.");

const buildBusOperation = (
  definition: CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>,
): OpenApiOperation => {
  const kind = definition.kind;
  const schemaId = definitionInputSchemaId(kind, definition.name);
  const operationPrefix = kind === "command" ? "command" : "query";
  const customerSelfService = isCustomerSelfService(definition);
  return Object.freeze({
    operationId: `${operationPrefix}_${definition.name.replaceAll(".", "_")}`,
    summary: definition.description,
    description: [
      definition.description_llm,
      `Stable ${kind} name: \`${definition.name}\` @ ${definition.version}.`,
      customerSelfService
        ? "HTTP body is the strict query input. The dedicated customer cookie and matching CSRF proof select the server-owned canonical customer; staff bearer tokens cannot authorize this route."
        : "HTTP body is the registry input (args). C1 wire envelope fields (command, version, idempotency_key, dry_run, mode) wrap this payload at the bus boundary.",
      "Responses use the unified A2 CommandResponse envelope.",
    ].join(" "),
    tags: Object.freeze([kind === "command" ? "commands" : "queries"]),
    ...(customerSelfService
      ? {
          parameters: Object.freeze([
            CUSTOMER_PORTAL_OPENAPI.csrfParameter,
            CUSTOMER_PORTAL_OPENAPI.authorityParameter,
          ]),
        }
      : {}),
    requestBody: Object.freeze({
      required: true as const,
      content: Object.freeze({
        "application/json": jsonContent(schemaRef(schemaId)),
      }),
    }),
    responses: Object.freeze({
      "200": successEnvelopeResponse("Unified A2 command/query envelope"),
      default: failureResponse("Unified A2 command failure envelope"),
    }),
    security: customerSelfService
      ? Object.freeze([
          Object.freeze({
            customerSession: Object.freeze([]),
            customerTabAuthority: Object.freeze([]),
            customerCsrfCookie: Object.freeze([]),
            csrfHeader: Object.freeze([]),
          }),
        ])
      : Object.freeze([{ bearerAuth: Object.freeze([]) }]),
    "x-laundry-kind": kind,
    "x-laundry-risk": definition.risk,
    "x-laundry-classification": definition.data_classification,
    "x-laundry-offline-mode": definition.offline_mode,
    "x-laundry-version": definition.version,
  });
};

const collectPathsAndSchemas = (): {
  paths: Record<string, OpenApiPathItem>;
  schemas: Record<string, OpenApiSchemaObject>;
} => {
  const paths: Record<string, OpenApiPathItem> = {};
  const schemas: Record<string, OpenApiSchemaObject> = { ...buildEnvelopeSchemas() };

  for (const row of AUTH_OPERATION_MATRIX) {
    registerAuthSchemas(schemas, row);
    paths[row.path] = Object.freeze({ post: buildAuthOperation(row) });
  }

  for (const [name, schema] of Object.entries(CUSTOMER_PORTAL_AUTH_SCHEMAS)) {
    schemas[name] = zodToOpenApiSchema(schema);
  }
  Object.assign(paths, CUSTOMER_PORTAL_AUTH_PATHS);

  for (const definition of [...M1_FIRST_WAVE_DEFINITIONS, ...M2_CONTRACT_DEFINITIONS]) {
    if (definition.name === "photo.register" || definition.name === "photo.delete") continue;
    const schemaId = definitionInputSchemaId(definition.kind, definition.name);
    schemas[schemaId] = zodToOpenApiSchema(definition.input);
    const path = busPathFor(definition.kind, definition.name);
    paths[path] = Object.freeze({ post: buildBusOperation(definition) });
  }

  return { paths, schemas };
};

const sortRecord = <T>(record: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
  const entries = Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(entries));
};

/** Deterministic OpenAPI 3.1 projection: sorted keys and no host-local data. */
export const buildLaundryOpenApiDocument = (): OpenApiDocument => {
  const { paths, schemas } = collectPathsAndSchemas();
  return Object.freeze({
    openapi: OPENAPI_VERSION,
    info: Object.freeze({
      title: "Laundry Desk v2 API",
      version: OPENAPI_INFO_VERSION,
      description: [
        "Contract-first OpenAPI 3.1 projection for frozen M1 and M2 counter contracts.",
        "Auth paths come solely from AUTH_OPERATION_MATRIX.",
        "Bus commands/queries come from M1_FIRST_WAVE_DEFINITIONS and M2_CONTRACT_DEFINITIONS.",
        "Errors use the A2 CommandResponse / CommandFailureResponse envelope.",
      ].join(" "),
    }),
    paths: sortRecord(paths),
    components: Object.freeze({
      schemas: sortRecord(schemas),
      securitySchemes: Object.freeze({
        bearerAuth: Object.freeze({
          type: "http" as const,
          scheme: "bearer" as const,
          bearerFormat: "JWT",
          description: "Memory-only access token (never store in cookies or Web Storage).",
        }),
        csrfHeader: Object.freeze({
          type: "apiKey" as const,
          in: "header" as const,
          name: CSRF_HEADER_NAME,
          description: "Double-submit CSRF header paired with the readable CSRF cookie.",
        }),
        customerSession: CUSTOMER_PORTAL_OPENAPI.sessionScheme,
        customerTabAuthority: CUSTOMER_PORTAL_OPENAPI.authorityScheme,
        customerCsrfCookie: CUSTOMER_PORTAL_OPENAPI.csrfCookieScheme,
      }),
    }),
  });
};

export const serializeOpenApiDocument = (document: OpenApiDocument): string =>
  `${JSON.stringify(sortKeysDeep(document), null, 2)}\n`;
