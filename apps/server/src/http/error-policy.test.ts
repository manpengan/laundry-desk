import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { installPublicErrorHandlers, publicErrorDecision } from "./error-policy.js";

test("only explicit request parser failures are mapped to public client errors", () => {
  assert.deepEqual(publicErrorDecision({ code: "FST_ERR_CTP_INVALID_JSON_BODY" }), {
    statusCode: 400,
    errorCode: "VALIDATION_FAILED",
    logMessage: "request parsing failed",
  });
  assert.deepEqual(publicErrorDecision({ code: "FST_ERR_CTP_EMPTY_JSON_BODY" }), {
    statusCode: 400,
    errorCode: "VALIDATION_FAILED",
    logMessage: "request parsing failed",
  });
  assert.deepEqual(publicErrorDecision({ code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" }), {
    statusCode: 415,
    errorCode: "VALIDATION_FAILED",
    logMessage: "request parsing failed",
  });
});

test("internal and unknown failures are sanitized as server errors", () => {
  for (const error of [
    new Error("secret SQL /private/path"),
    { statusCode: 400 },
    { statusCode: 415 },
    { code: "FST_ERR_CTP_BODY_TOO_LARGE" },
    null,
  ]) {
    assert.deepEqual(publicErrorDecision(error), {
      statusCode: 500,
      errorCode: "TRANSACTION_FAILED",
      logMessage: "request failed",
    });
  }
});

test("installed handler never presents a thrown route failure as validation", async () => {
  const app = Fastify({ logger: false });
  installPublicErrorHandlers(app);
  app.get("/boom", async () => {
    throw new Error("database password and SQL must not escape");
  });

  const response = await app.inject({ method: "GET", url: "/boom" });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.json(), {
    ok: false,
    error: {
      code: "TRANSACTION_FAILED",
      message: "Command transaction failed",
    },
  });
  assert.doesNotMatch(response.body, /database|password|SQL/iu);
  await app.close();
});
