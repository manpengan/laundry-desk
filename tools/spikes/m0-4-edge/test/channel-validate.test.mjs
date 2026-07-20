import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Mirror of wss-server validate rules for unit evidence without binding ports. */
function validateMessage(raw, seenNonces, now = Date.now()) {
  const MAX_SKEW_MS = 30_000;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (typeof msg.nonce !== "string" || typeof msg.seq !== "number") {
    return { ok: false, error: "missing_nonce_or_seq" };
  }
  if (typeof msg.exp !== "number") {
    return { ok: false, error: "missing_exp" };
  }
  if (msg.exp < now - MAX_SKEW_MS) {
    return { ok: false, error: "expired" };
  }
  if (seenNonces.has(msg.nonce)) {
    return { ok: false, error: "replay" };
  }
  seenNonces.set(msg.nonce, msg.exp);
  return { ok: true, msg };
}

describe("channel anti-replay", () => {
  it("accepts fresh message and rejects replay", () => {
    const seen = new Map();
    const msg = {
      nonce: "n1",
      seq: 1,
      exp: Date.now() + 10_000,
      payload: { type: "ping" },
    };
    const a = validateMessage(JSON.stringify(msg), seen);
    assert.equal(a.ok, true);
    const b = validateMessage(JSON.stringify(msg), seen);
    assert.equal(b.ok, false);
    assert.equal(b.error, "replay");
  });

  it("rejects expired", () => {
    const seen = new Map();
    const msg = {
      nonce: "n2",
      seq: 1,
      exp: Date.now() - 60_000,
    };
    const r = validateMessage(JSON.stringify(msg), seen);
    assert.equal(r.error, "expired");
  });
});
