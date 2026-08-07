import assert from "node:assert/strict";
import test from "node:test";

import { z } from "zod";

import { validationErrorFrom } from "./validation-error.js";

function parseFailure(schema: z.ZodType, input: unknown): z.ZodError {
  const result = schema.safeParse(input);
  if (result.success) assert.fail("expected schema parse failure");
  return result.error;
}

test("top-level strict-object failures omit the forbidden root JSON pointer", () => {
  const error = validationErrorFrom(parseFailure(z.strictObject({}), { org_id: "forged" }));
  assert.deepEqual(error, {
    code: "VALIDATION_FAILED",
    message: "Request validation failed",
  });
});

test("field details encode RFC 6901 path segments", () => {
  const schema = z.strictObject({ "a/b~c": z.string().min(1) });
  const error = validationErrorFrom(parseFailure(schema, { "a/b~c": "" }));
  assert.equal("detail" in error, true);
  if (!("detail" in error)) return;
  assert.deepEqual(error.detail, { kind: "field", path: "/a~1b~0c" });
});
