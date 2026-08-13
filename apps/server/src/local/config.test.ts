import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalRuntime, createMemoryLocalRuntime } from "./create-runtime.js";
import {
  parseLocalHostConfig,
  parseLocalPhotoStoreDir,
  parseLocalServerConfig,
  parseNotificationProviderMode,
} from "./config.js";

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
    browserFetchSite: "same-site",
    cookieSecure: false,
    hostAuthorities: ["127.0.0.1:8787"],
    trustedProxyClientIpRequired: false,
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
    browserFetchSite: "same-site",
    cookieSecure: false,
    hostAuthorities: ["127.0.0.1:8787"],
    trustedProxyClientIpRequired: false,
    accessTokenSecret: ACCESS_SECRET,
    csrfProofSecret: CSRF_SECRET,
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.hostAuthorities), true);
});

test("LAN profile requires an exact private HTTPS origin and enables secure browser policy", () => {
  assert.deepEqual(parseLocalHostConfig({ LAUNDRY_LAN_ORIGIN: "https://192.168.50.12:8443" }), {
    listenHost: "127.0.0.1",
    port: 8787,
    browserOrigin: "https://192.168.50.12:8443",
    browserFetchSite: "same-origin",
    cookieSecure: true,
    hostAuthorities: ["127.0.0.1:8787"],
    trustedProxyClientIpRequired: false,
  });
  assert.equal(parseLocalHostConfig({ LAUNDRY_LAN_ORIGIN: "" }).cookieSecure, false);

  for (const origin of [
    "http://192.168.50.12:8443",
    "https://127.0.0.1:8443",
    "https://198.18.0.1:8443",
    "https://example.com",
    "https://192.168.50.12",
    "https://192.168.50.12:443",
    "https://192.168.50.12:65536",
    "https://192.168.50.12:8443/owner",
    "https://user@192.168.50.12:8443",
    " https://192.168.50.12:8443",
  ]) {
    assert.throws(
      () => parseLocalHostConfig({ LAUNDRY_LAN_ORIGIN: origin }),
      /LAUNDRY_LAN_ORIGIN/u,
      origin,
    );
  }
});

test("cloud profile accepts an exact public HTTPS origin on the default port", () => {
  // ADR-36: the cloud test environment sits behind Caddy on a real domain, so
  // it needs an origin the LAN schema deliberately rejects (a hostname, and
  // port 443). It is a separate variable rather than a relaxation of
  // LAUNDRY_LAN_ORIGIN, whose private-IPv4 + high-port rule is load-bearing for
  // ADR-32 and must not widen.
  assert.deepEqual(parseLocalHostConfig({ LAUNDRY_PUBLIC_ORIGIN: "https://desk.manpengan.xyz" }), {
    listenHost: "127.0.0.1",
    port: 8787,
    browserOrigin: "https://desk.manpengan.xyz",
    browserFetchSite: "same-origin",
    cookieSecure: true,
    hostAuthorities: ["127.0.0.1:8787"],
    trustedProxyClientIpRequired: true,
  });
  assert.equal(parseLocalHostConfig({ LAUNDRY_PUBLIC_ORIGIN: "" }).cookieSecure, false);

  for (const origin of [
    "http://desk.manpengan.xyz",
    "https://192.168.50.12:8443",
    "https://127.0.0.1",
    "https://localhost",
    "https://-desk.manpengan.xyz",
    "https://desk-.manpengan.xyz",
    "https://desk.manpengan.xyz:8443",
    "https://desk.manpengan.xyz/owner",
    "https://user@desk.manpengan.xyz",
    " https://desk.manpengan.xyz",
    "https://desk.manpengan.xyz?a=1",
  ]) {
    assert.throws(
      () => parseLocalHostConfig({ LAUNDRY_PUBLIC_ORIGIN: origin }),
      /LAUNDRY_PUBLIC_ORIGIN/u,
      origin,
    );
  }
});

test("the two origin profiles are mutually exclusive", () => {
  assert.throws(
    () =>
      parseLocalHostConfig({
        LAUNDRY_LAN_ORIGIN: "https://192.168.50.12:8443",
        LAUNDRY_PUBLIC_ORIGIN: "https://desk.manpengan.xyz",
      }),
    /LAUNDRY_PUBLIC_ORIGIN/u,
    "a server cannot claim two browser origins at once",
  );
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

test("loads signing secrets from container secret files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-signing-files-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const accessPath = join(root, "access");
  const csrfPath = join(root, "csrf");
  await writeFile(accessPath, ACCESS_SECRET, { mode: 0o600 });
  await writeFile(csrfPath, CSRF_SECRET, { mode: 0o600 });

  assert.deepEqual(
    parseLocalServerConfig({
      LAUNDRY_ACCESS_TOKEN_SECRET_FILE: accessPath,
      LAUNDRY_CSRF_PROOF_SECRET_FILE: csrfPath,
      LAUNDRY_CONTAINER_RUNTIME: "1",
    }),
    {
      listenHost: "0.0.0.0",
      port: 8787,
      browserOrigin: "http://127.0.0.1:5173",
      browserFetchSite: "same-site",
      cookieSecure: false,
      hostAuthorities: ["127.0.0.1:8787"],
      trustedProxyClientIpRequired: false,
      accessTokenSecret: ACCESS_SECRET,
      csrfProofSecret: CSRF_SECRET,
    },
  );
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

test("notification provider stays disabled unless software-only mode is explicit", () => {
  assert.equal(parseNotificationProviderMode({}), "disabled");
  assert.equal(
    parseNotificationProviderMode({ LAUNDRY_NOTIFICATION_PROVIDER_MODE: "" }),
    "disabled",
  );
  assert.equal(
    parseNotificationProviderMode({ LAUNDRY_NOTIFICATION_PROVIDER_MODE: "disabled" }),
    "disabled",
  );
  assert.equal(
    parseNotificationProviderMode({ LAUNDRY_NOTIFICATION_PROVIDER_MODE: "software_only" }),
    "software_only",
  );
  for (const invalid of ["external", "fake", "software-only", " software_only", "1"]) {
    assert.throws(
      () => parseNotificationProviderMode({ LAUNDRY_NOTIFICATION_PROVIDER_MODE: invalid }),
      /LAUNDRY_NOTIFICATION_PROVIDER_MODE/u,
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
