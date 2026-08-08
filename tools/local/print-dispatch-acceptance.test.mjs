import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  PrintDispatchAcceptanceError,
  requiredEnvironment,
  validateCapturedEscPos,
} from "./print-dispatch-acceptance.mjs";

test("print dispatch acceptance requires credentials without echoing values", () => {
  assert.throws(
    () => requiredEnvironment({ LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin" }),
    (error) =>
      error instanceof PrintDispatchAcceptanceError &&
      error.code === "PRINT_ACCEPTANCE_ENV_INVALID",
  );
  assert.deepEqual(
    requiredEnvironment({
      LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
      LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "not-a-real-secret",
    }),
    {
      LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
      LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "not-a-real-secret",
    },
  );
});

test("fake lp capture must contain an initialized and cut ESC/POS receipt", () => {
  const valid = Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.alloc(80, 0x41),
    Buffer.from([0x1d, 0x56, 0x00]),
  ]);
  assert.doesNotThrow(() => validateCapturedEscPos(valid));
  assert.throws(
    () => validateCapturedEscPos(Buffer.from("plain text receipt")),
    (error) => error?.code === "PRINT_ACCEPTANCE_ESC_POS_INVALID",
  );
});

test("print acceptance pairs for grant trust without taking the counter Primary lease", async () => {
  const source = await readFile(
    new URL("./print-dispatch-acceptance.mjs", import.meta.url),
    "utf8",
  );
  const pairing = source.slice(
    source.indexOf("async function pairDevice"),
    source.indexOf("async function firstOrderId"),
  );
  assert.match(pairing, /request_primary:\s*false/u);
  assert.match(pairing, /createSignedAuthorityRequest\([^;]+requestNonce,\s*false\)/su);
  assert.doesNotMatch(pairing, /request_primary:\s*true|requestNonce,\s*true/u);
});
