import assert from "node:assert/strict";
import test from "node:test";
import { verifySupportCommand } from "./protocol.js";
import { assistanceBrokerOrigin, createAssistanceTransport } from "./transport.js";
import { proofFixture } from "./test-fixture.js";
test("support evidence binds signature, issuer, audience, MFA, recent auth, session and one-use nonce", () => {
  const f = proofFixture(),
    expected = { sessionId: f.claims.session_id, nonce: f.claims.nonce, now: f.now };
  assert.equal(verifySupportCommand(f.signed(), f.trust, expected).command, "runtime.health");
  for (const patch of [
    { iss: "wrong" },
    { aud: "wrong" },
    { nonce: "a".repeat(43) },
    { session_id: "00000000-0000-4000-8000-000000000001" },
    { exp: f.now / 1000 },
    { exp: f.now / 1000 + 61 },
    { iat: f.now / 1000 + 1 },
    { auth_time: f.now / 1000 - 301 },
    { amr: ["pwd", "mfa"] },
    { amr: ["pwd", "otp"] },
    { command: "shell" },
    { sql: "SELECT * FROM customers" },
  ])
    assert.throws(() =>
      verifySupportCommand(f.signed({ ...f.claims, ...patch }), f.trust, expected),
    );
  for (const header of [
    { alg: "HS256", typ: "JWT", kid: f.trust.kid },
    { alg: "EdDSA", typ: "JWT", kid: "wrong" },
    { alg: "EdDSA", typ: "JWT", kid: f.trust.kid, jku: "https://attacker.example" },
  ])
    assert.throws(() => verifySupportCommand(f.signed(f.claims, header), f.trust, expected));
  const parts = f.signed().split(".");
  assert.throws(() =>
    verifySupportCommand(
      `${parts[0]}.${parts[1]}.${Buffer.alloc(64).toString("base64url")}`,
      f.trust,
      expected,
    ),
  );
  assert.throws(() => verifySupportCommand(f.signed(), proofFixture().trust, expected));
});
test("broker accepts only a fixed HTTPS origin and bounded strict response envelopes", async () => {
  const f = proofFixture();
  for (const url of [
    "http://support.example/",
    "https://user@support.example/",
    "https://support.example:8443/",
    "https://support.example/path",
    "https://support.example/?key=x",
    "https://[::1]/",
  ])
    assert.throws(() => assistanceBrokerOrigin(url));
  const bodies: string[] = [];
  const transport = createAssistanceTransport(f.trust, {
    request: async (input) => {
      assert.equal(input.url, "https://support.example/v1/assistance/poll");
      assert.equal(input.method, "POST");
      bodies.push(input.body ?? "");
      return {
        status: 200,
        contentType: "application/json",
        body: (async function* () {
          yield Buffer.from('{"command":null}');
        })(),
      };
    },
  });
  assert.equal(
    await transport.poll(f.claims.session_id, f.claims.nonce, new AbortController().signal),
    null,
  );
  assert.doesNotMatch(bodies.join(""), /broker_token|customer|password/);
  for (const text of ['{"command":null,"url":"https://attacker.example"}', "x".repeat(16385)]) {
    const invalid = createAssistanceTransport(f.trust, {
      request: async () => ({
        status: 200,
        contentType: "application/json",
        body: (async function* () {
          yield Buffer.from(text);
        })(),
      }),
    });
    await assert.rejects(
      invalid.poll(f.claims.session_id, f.claims.nonce, new AbortController().signal),
    );
  }
});
