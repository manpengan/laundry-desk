import assert from "node:assert/strict";
import test from "node:test";

import { canonicalize, freezeCanonical, hashCanonical } from "./canonical.js";

test("canonicalize sorts object keys stably", () => {
  const a = canonicalize({ b: 1, a: 2, nested: { z: true, a: false } });
  const b = canonicalize({ nested: { a: false, z: true }, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"nested":{"a":false,"z":true}}');
});

test("changing args changes hash (WYSIWYS)", () => {
  const base = { order_id: "x", amount_cents: 100, note: "ok" };
  const changed = { order_id: "x", amount_cents: 101, note: "ok" };
  assert.notEqual(hashCanonical(base), hashCanonical(changed));
});

test("key order does not change hash", () => {
  assert.equal(
    hashCanonical({ amount_cents: 100, order_id: "x" }),
    hashCanonical({ order_id: "x", amount_cents: 100 }),
  );
});

test("freezeCanonical deep-freezes tree", () => {
  const frozen = freezeCanonical({ items: [{ qty: 1 }], flag: true });
  assert.ok(Object.isFrozen(frozen));
  assert.equal(typeof frozen, "object");
  assert.notEqual(frozen, null);
  assert.equal(Array.isArray(frozen), false);
  const record = frozen as { readonly [key: string]: unknown };
  assert.ok(Object.isFrozen(record.items));
});

test("rejects prototype keys and non-integers", () => {
  const withProto = JSON.parse('{"__proto__":{"x":1}}') as unknown;
  assert.throws(() => canonicalize(withProto), /prototype/);
  assert.throws(() => canonicalize({ n: 1.5 }), /safe integers/);
  assert.throws(() => canonicalize({ n: -0 }), /safe integers/);
});
