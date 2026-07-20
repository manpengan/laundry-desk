import assert from "node:assert/strict";
import test from "node:test";
import { isValidAppSender } from "./sender.js";

test("isValidAppSender accepts only app:// origins", () => {
  assert.equal(isValidAppSender("app://local/index.html"), true);
  assert.equal(isValidAppSender("app://local/"), true);
  assert.equal(isValidAppSender("https://evil.example/"), false);
  assert.equal(isValidAppSender("file:///tmp/x"), false);
  assert.equal(isValidAppSender(""), false);
  assert.equal(isValidAppSender(undefined), false);
  assert.equal(isValidAppSender(null), false);
});
