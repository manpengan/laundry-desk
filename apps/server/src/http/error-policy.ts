import type { FastifyInstance } from "fastify";

import { createCommandError, type CommandErrorCode } from "@laundry/contracts";

import { safeErrorContext } from "./local-logger.js";

type PublicErrorDecision = Readonly<{
  statusCode: 400 | 415 | 500;
  errorCode: CommandErrorCode;
  logMessage: "request parsing failed" | "request failed";
}>;

const JSON_PARSE_CODES = Object.freeze(
  new Set(["FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_JSON_BODY"]),
);
const VALIDATION_ERROR = Object.freeze({
  errorCode: "VALIDATION_FAILED" as const,
  logMessage: "request parsing failed" as const,
});
const SERVER_ERROR: PublicErrorDecision = Object.freeze({
  statusCode: 500,
  errorCode: "TRANSACTION_FAILED",
  logMessage: "request failed",
});

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const value = (error as Readonly<Record<string, unknown>>).code;
  return typeof value === "string" ? value : null;
}

export function publicErrorDecision(error: unknown): PublicErrorDecision {
  const code = errorCode(error);
  if (code !== null && JSON_PARSE_CODES.has(code)) {
    return Object.freeze({ statusCode: 400 as const, ...VALIDATION_ERROR });
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return Object.freeze({ statusCode: 415 as const, ...VALIDATION_ERROR });
  }
  return SERVER_ERROR;
}

function failureEnvelope(code: CommandErrorCode) {
  return Object.freeze({
    ok: false as const,
    error: createCommandError(code),
  });
}

export function installPublicErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const decision = publicErrorDecision(error);
    request.log.error(safeErrorContext(error), decision.logMessage);
    return reply.code(decision.statusCode).send(failureEnvelope(decision.errorCode));
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(failureEnvelope("RESOURCE_UNAVAILABLE")),
  );
}
