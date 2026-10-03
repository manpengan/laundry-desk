import assert from "node:assert/strict";
import { randomBytes, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { supportOperation } from "./support-client.mjs";
test("support client forwards externally signed evidence and never manufactures MFA claims", async () => {
  const keys = generateKeyPairSync("ed25519"),
    session_id = randomUUID(),
    nonce = randomBytes(32).toString("base64url"),
    id = randomUUID(),
    now = Date.now();
  const trust = {
    version: 1,
    broker_url: "https://support.example/",
    issuer: "fixture",
    audience: "fixture-support",
    kid: "test",
    public_key_spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const claims = {
    iss: trust.issuer,
    aud: trust.audience,
    sub: "synthetic",
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 60,
    auth_time: Math.floor(now / 1000),
    amr: ["mfa", "otp"],
    session_id,
    nonce,
    jti: id,
    command: "runtime.health",
  };
  const data = [{ alg: "EdDSA", typ: "JWT", kid: trust.kid }, claims]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  const proof = `${data}.${sign(null, Buffer.from(data), keys.privateKey).toString("base64url")}`;
  const input = {
    operation: "submit",
    trust,
    operator_access_token: "synthetic-operator-token",
    session_id,
    nonce,
    proof,
  };
  let calls = 0;
  const http = {
    request: async (request) => {
      calls++;
      assert.equal(request.url, "https://support.example/v1/support/submit");
      assert.deepEqual(JSON.parse(request.body), { session_id, proof });
      return {
        status: 200,
        contentType: "application/json",
        body: (async function* () {
          yield Buffer.from(JSON.stringify({ accepted: true, request_id: id }));
        })(),
      };
    },
  };
  assert.deepEqual(await supportOperation(input, http, now), { accepted: true, request_id: id });
  await assert.rejects(supportOperation({ ...input, nonce: "x".repeat(43) }, http, now));
  assert.equal(calls, 1);
});

test("support result reader accepts only the expected command's redacted result", async () => {
  const keys = generateKeyPairSync("ed25519"),
    session_id = randomUUID(),
    request_id = randomUUID();
  const input = {
    operation: "result",
    operator_access_token: "synthetic-operator-token",
    session_id,
    request_id,
    command: "runtime.health",
    trust: {
      version: 1,
      broker_url: "https://support.example/",
      issuer: "fixture",
      audience: "support",
      kid: "test",
      public_key_spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    },
  };
  const valid = {
    ready: true,
    request_id,
    command: "runtime.health",
    result: { database: "ready", mode: "windows_local" },
  };
  const transport = (body) => ({
    request: async () => ({
      status: 200,
      contentType: "application/json",
      body: (async function* () {
        yield Buffer.from(JSON.stringify(body));
      })(),
    }),
  });
  assert.deepEqual(await supportOperation(input, transport(valid)), valid);
  for (const value of [
    { ...valid, result: { ...valid.result, password: "leak" } },
    { ...valid, command: "shell" },
    { ...valid, request_id: randomUUID() },
  ])
    await assert.rejects(supportOperation(input, transport(value)));
});
