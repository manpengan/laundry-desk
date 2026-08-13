import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalLoggerOptions,
  LOCAL_LOG_REDACTION_PATHS,
  safeErrorContext,
} from "./local-logger.js";

test("local logger redacts every credential-bearing field", () => {
  const paths = new Set<string>(LOCAL_LOG_REDACTION_PATHS);
  for (const path of [
    "req.headers.authorization",
    "req.headers.cookie",
    'req.headers["x-csrf-token"]',
    'req.headers["x-customer-portal-authority"]',
    'req.headers["x-laundry-proxy-client-ip"]',
    'res.headers["set-cookie"]',
    "body.password",
    "body.pin",
    "body.access_token",
    "body.refresh_token",
    "body.csrf_token",
    "body.token",
  ]) {
    assert.equal(paths.has(path), true, path);
  }
  const options = createLocalLoggerOptions();
  assert.equal(options.redact.censor, "[REDACTED]");
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options.redact), true);
  assert.equal(Object.isFrozen(options.redact.paths), true);
});

test("safe error context never serializes error messages, stacks, SQL, or paths", () => {
  const sentinel = "password=secret SELECT * FROM /private/path token=abc";
  const context = safeErrorContext(new Error(sentinel));
  assert.deepEqual(context, { error_type: "Error" });
  assert.doesNotMatch(JSON.stringify(context), /secret|SELECT|private|abc/u);

  const attackerNamed = new Error("safe");
  attackerNamed.name = sentinel;
  assert.deepEqual(safeErrorContext(attackerNamed), { error_type: "UnknownError" });
});
