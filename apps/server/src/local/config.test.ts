import assert from "node:assert/strict";
import test from "node:test";

import { createLocalRuntime, createMemoryLocalRuntime } from "./create-runtime.js";
import { parseLocalHostConfig, parseLocalServerConfig } from "./config.js";

const ACCESS_SECRET = "access-secret-is-at-least-32-bytes";
const CSRF_SECRET = "csrf-proof-secret-is-at-least-32-bytes";

test("default memory runtime needs only the strict host configuration", async () => {
  const hostConfig = parseLocalHostConfig({});
  const runtime = await createLocalRuntime({});

  assert.deepEqual(hostConfig, {
    listenHost: "127.0.0.1",
    port: 8787,
    browserOrigin: "http://127.0.0.1:5173",
    hostAuthorities: ["127.0.0.1:8787"],
  });
  assert.equal(runtime.mode, "memory");
  assert.ok(Buffer.byteLength(runtime.accessTokenSecret, "utf8") >= 32);
  assert.ok(Buffer.byteLength(runtime.csrfProofSecret, "utf8") >= 32);
});

test("memory runtime still rejects an invalid host boundary", async () => {
  await assert.rejects(
    () => createLocalRuntime({ LAUNDRY_CONTAINER_RUNTIME: "true" }),
    /LAUNDRY_CONTAINER_RUNTIME/u,
  );
});

test("parses the fixed loopback local server boundary", () => {
  const config = parseLocalServerConfig({
    LAUNDRY_ACCESS_TOKEN_SECRET: ACCESS_SECRET,
    LAUNDRY_CSRF_PROOF_SECRET: CSRF_SECRET,
  });

  assert.deepEqual(config, {
    listenHost: "127.0.0.1",
    port: 8787,
    browserOrigin: "http://127.0.0.1:5173",
    hostAuthorities: ["127.0.0.1:8787"],
    accessTokenSecret: ACCESS_SECRET,
    csrfProofSecret: CSRF_SECRET,
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.hostAuthorities), true);
});

test("allows 0.0.0.0 only for the explicit container runtime", () => {
  const config = parseLocalServerConfig({
    LAUNDRY_ACCESS_TOKEN_SECRET: ACCESS_SECRET,
    LAUNDRY_CSRF_PROOF_SECRET: CSRF_SECRET,
    LAUNDRY_CONTAINER_RUNTIME: "1",
  });

  assert.equal(config.listenHost, "0.0.0.0");
  assert.throws(
    () =>
      parseLocalServerConfig({
        LAUNDRY_ACCESS_TOKEN_SECRET: ACCESS_SECRET,
        LAUNDRY_CSRF_PROOF_SECRET: CSRF_SECRET,
        LAUNDRY_CONTAINER_RUNTIME: "true",
      }),
    /LAUNDRY_CONTAINER_RUNTIME/u,
  );
});

test("rejects missing, short, or identical signing secrets without exposing values", () => {
  assert.throws(() => parseLocalServerConfig({}), /LAUNDRY_ACCESS_TOKEN_SECRET/u);

  const leakedAccessCandidate = "short-access-value";
  assert.throws(
    () =>
      parseLocalServerConfig({
        LAUNDRY_ACCESS_TOKEN_SECRET: leakedAccessCandidate,
        LAUNDRY_CSRF_PROOF_SECRET: CSRF_SECRET,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /LAUNDRY_ACCESS_TOKEN_SECRET/u);
      assert.doesNotMatch(error.message, new RegExp(leakedAccessCandidate, "u"));
      return true;
    },
  );

  assert.throws(
    () =>
      parseLocalServerConfig({
        LAUNDRY_ACCESS_TOKEN_SECRET: ACCESS_SECRET,
        LAUNDRY_CSRF_PROOF_SECRET: "short-csrf-value",
      }),
    /LAUNDRY_CSRF_PROOF_SECRET/u,
  );

  assert.throws(
    () =>
      parseLocalServerConfig({
        LAUNDRY_ACCESS_TOKEN_SECRET: ACCESS_SECRET,
        LAUNDRY_CSRF_PROOF_SECRET: ACCESS_SECRET,
      }),
    /must be independent/u,
  );
});

test("measures signing secret strength in UTF-8 bytes", () => {
  const config = parseLocalServerConfig({
    LAUNDRY_ACCESS_TOKEN_SECRET: "台".repeat(11),
    LAUNDRY_CSRF_PROOF_SECRET: CSRF_SECRET,
  });

  assert.equal(config.accessTokenSecret, "台".repeat(11));
});

test("PG selection fails closed before opening a pool when secrets are absent", async () => {
  await assert.rejects(
    () => createLocalRuntime({ LAUNDRY_USE_LOCAL_PG: "1" }),
    /LAUNDRY_ACCESS_TOKEN_SECRET/u,
  );
});

test("memory runtimes receive independent random access and CSRF secrets", async () => {
  const first = await createMemoryLocalRuntime();
  const second = await createMemoryLocalRuntime();

  assert.notEqual(first.accessTokenSecret, first.csrfProofSecret);
  assert.notEqual(first.accessTokenSecret, second.accessTokenSecret);
  assert.notEqual(first.csrfProofSecret, second.csrfProofSecret);
  assert.ok(Buffer.byteLength(first.accessTokenSecret, "utf8") >= 32);
  assert.ok(Buffer.byteLength(first.csrfProofSecret, "utf8") >= 32);
});
