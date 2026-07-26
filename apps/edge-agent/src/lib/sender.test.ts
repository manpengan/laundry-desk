import assert from "node:assert/strict";
import test from "node:test";
import { isValidAppSender, isValidDesktopSender } from "./sender.js";

test("isValidAppSender accepts only normalized app://local URLs", () => {
  assert.equal(isValidAppSender("app://local/index.html"), true);
  assert.equal(isValidAppSender("app://local/"), true);
  assert.equal(isValidAppSender("app://evil/index.html"), false);
  assert.equal(isValidAppSender("app://LOCAL/index.html"), false);
  assert.equal(isValidAppSender("app://local/a/../index.html"), false);
  assert.equal(isValidAppSender("app://local/%69ndex.html"), false);
  assert.equal(isValidAppSender("app://local/index.html?debug=1"), false);
  assert.equal(isValidAppSender("app://local/index.html#fragment"), false);
  assert.equal(isValidAppSender("https://evil.example/"), false);
  assert.equal(isValidAppSender("file:///tmp/x"), false);
  assert.equal(isValidAppSender(""), false);
  assert.equal(isValidAppSender(undefined), false);
  assert.equal(isValidAppSender(null), false);
});

test("desktop IPC sender must be the expected window main frame", () => {
  const valid = Object.freeze({
    senderUrl: "app://local/index.html",
    senderWebContentsId: 17,
    expectedWebContentsId: 17,
    isMainFrame: true,
  });
  assert.equal(isValidDesktopSender(valid), true);
  assert.equal(
    isValidDesktopSender({ ...valid, senderWebContentsId: valid.senderWebContentsId + 1 }),
    false,
  );
  assert.equal(isValidDesktopSender({ ...valid, isMainFrame: false }), false);
  assert.equal(isValidDesktopSender({ ...valid, senderUrl: "app://evil/index.html" }), false);
});
