import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
  canonicalize,
  firstExecutable,
  runtimeTestingBuildArguments,
  sha256,
} from "./runtime-counter-loopback-artifacts.mjs";

test("canonical manifest serialization recursively sorts without mutating input", () => {
  const original = { z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } };
  const canonical = canonicalize(original);
  assert.equal(JSON.stringify(canonical), '{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}');
  assert.deepEqual(Object.keys(original), ["z", "a"]);
  assert.notEqual(canonical, original);
});

test("artifact hashing and executable discovery are deterministic", async () => {
  assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    await firstExecutable([process.execPath], "UNREACHABLE"),
    await realpath(process.execPath),
  );
  await assert.rejects(
    () => firstExecutable(["/path/that/must/not/exist"], "RUNTIME_COUNTER_TEST_MISSING"),
    /RUNTIME_COUNTER_TEST_MISSING/u,
  );
});

test("Runtime build receives the acceptance-owned signing key and app paths", () => {
  assert.deepEqual(
    runtimeTestingBuildArguments(
      "/repo/runtime-kit",
      "/private/root/key.pem",
      "/private/root/runtime-app",
    ),
    [
      "/repo/runtime-kit/build-app.mjs",
      "--testing",
      "--testing-signing-key-output",
      "/private/root/key.pem",
      "--testing-output-root",
      "/private/root/runtime-app",
    ],
  );
});
