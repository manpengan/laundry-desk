import assert from "node:assert/strict";
import test from "node:test";

import { createLocalRuntime, createMemoryLocalRuntime } from "./create-runtime.js";
import { parseLocalHostConfig, parseLocalPhotoStoreDir, parseLocalServerConfig } from "./config.js";

const ACCESS_SECRET = "access-secret-is-at-least-32-bytes";
const CSRF_SECRET = "csrf-proof-secret-is-at-least-32-bytes";

test("explicit memory runtime stays isolated from the strict host configuration", async () => {
  const hostConfig = parseLocalHostConfig({});
  const runtime = await createMemoryLocalRuntime();
  const csrfCapability = runtime.csrfProofSigner;

  assert.deepEqual(hostConfig, {
    listenHost: "127.0.0.1",
    port: 8787,
    browserOrigin: "http://127.0.0.1:5173",
    hostAuthorities: ["127.0.0.1:8787"],
  });
  assert.equal(runtime.mode, "memory");
  assert.ok(Buffer.byteLength(runtime.accessTokenSecret, "utf8") >= 32);
  assert.equal(typeof csrfCapability.mint, "function");
  assert.equal("csrfProofSecret" in runtime, false);
  assert.equal(runtime.identity.sessions.csrfProofMinter, csrfCapability);
});

test("strict host configuration rejects an invalid container boundary", () => {
  assert.throws(
    () => parseLocalHostConfig({ LAUNDRY_CONTAINER_RUNTIME: "true" }),
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

test("photo storage accepts only the dedicated compose mount", () => {
  assert.equal(parseLocalPhotoStoreDir({}), null);
  assert.equal(
    parseLocalPhotoStoreDir({ LAUNDRY_PHOTO_STORE_DIR: " /var/lib/laundry/photos " }),
    "/var/lib/laundry/photos",
  );
  for (const candidate of [
    "/",
    "/etc",
    "/tmp/photos",
    "/var/lib/laundry/photos/../..",
    "relative/photos",
  ]) {
    assert.throws(
      () => parseLocalPhotoStoreDir({ LAUNDRY_PHOTO_STORE_DIR: candidate }),
      /must be \/var\/lib\/laundry\/photos/u,
    );
  }
});

test("PG selection fails closed before opening a pool when secrets are absent", async () => {
  await assert.rejects(
    () =>
      createLocalRuntime({
        LAUNDRY_USE_LOCAL_PG: "1",
        LAUNDRY_PG_APP_URL: "postgresql://laundry_app:test@127.0.0.1:8543/laundry_v2",
      }),
    /LAUNDRY_ACCESS_TOKEN_SECRET/u,
  );
});

test("memory runtimes receive independent access secrets and isolated CSRF signer capabilities", async () => {
  const first = await createMemoryLocalRuntime();
  const second = await createMemoryLocalRuntime();
  const binding = Object.freeze({
    session_id: "11111111-1111-4111-8111-111111111111",
    session_version: 1,
    rotation_nonce: "22222222-2222-4222-8222-222222222222",
  });
  const firstSigner = first.csrfProofSigner;
  const secondSigner = second.csrfProofSigner;
  const firstProof = firstSigner.mint(binding);
  const secondProof = secondSigner.mint(binding);

  assert.notEqual(first.accessTokenSecret, second.accessTokenSecret);
  assert.notEqual(firstProof, secondProof);
  assert.equal(firstSigner.verify(firstProof, binding), true);
  assert.equal(firstSigner.verify(secondProof, binding), false);
  assert.equal(secondSigner.verify(secondProof, binding), true);
  assert.equal(first.identity.sessions.csrfProofMinter, firstSigner);
  assert.equal(second.identity.sessions.csrfProofMinter, secondSigner);
  assert.equal("csrfProofSecret" in first, false);
  assert.equal("csrfProofSecret" in second, false);
  assert.ok(Buffer.byteLength(first.accessTokenSecret, "utf8") >= 32);
});
