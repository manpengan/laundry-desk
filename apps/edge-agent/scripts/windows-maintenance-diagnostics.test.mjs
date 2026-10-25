import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  maintenanceFailure,
  observeMaintenancePage,
  redactedPageUrl,
} from "../e2e/windows-maintenance-diagnostics.mjs";

function page(evaluate) {
  return Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => "app://local/index.html?token=private#customer-name",
    evaluate,
  });
}

test("a missing or destroyed panel preserves the primary timeout and records no private error text", async () => {
  const primary = new Error("PRIMARY_EXPECT_TIMEOUT");
  const target = page(async () => {
    throw new TypeError("password=secret customer=private");
  });
  const observer = observeMaintenancePage(target);
  target.emit("pageerror", new TypeError("secret customer contents"));
  target.emit("console", {
    type: () => "error",
    text: () => {
      throw new Error("must not read console text");
    },
  });
  target.emit("crash");
  const failure = await maintenanceFailure(
    "COUNTER_BACKUP_HEALTH_NOT_SHOWN",
    primary,
    target,
    observer,
  );
  assert.equal(failure.cause, primary);
  assert.match(failure.message, /"status":"unavailable"/u);
  assert.match(failure.message, /"crashed":true/u);
  assert.match(failure.message, /"page_errors":1/u);
  assert.match(failure.message, /"console_errors":1/u);
  assert.doesNotMatch(failure.message, /secret|private|customer-name|password|token=/u);
  observer.dispose();
  assert.equal(target.listenerCount("pageerror"), 0);
});

test("a hung diagnostic is bounded and a late rejection cannot mask the primary error", async () => {
  let rejectRead;
  const target = page(
    () =>
      new Promise((_resolve, reject) => {
        rejectRead = reject;
      }),
  );
  const primary = new Error("ORIGINAL_VISIBLE_ASSERTION");
  const started = Date.now();
  const failure = await maintenanceFailure(
    "COUNTER_BACKUP_HEALTH_NOT_SHOWN",
    primary,
    target,
    undefined,
    10,
  );
  assert.equal(failure.cause, primary);
  assert.match(failure.message, /"status":"timeout"/u);
  assert.ok(Date.now() - started < 1000);
  rejectRead(new Error("late private renderer error"));
  await new Promise((resolve) => setImmediate(resolve));
});

test("renderer navigation to login is retained as structural state without DOM payloads", async () => {
  const target = page(async () => ({
    login_present: true,
    login_visible: true,
    shell_present: false,
    shell_visible: false,
    backup_region_present: false,
    backup_region_visible: false,
    backup_alert_present: false,
    backup_reading: false,
    backup_checked: false,
    document_focused: false,
    document_visibility: "hidden",
    document_ready: "complete",
    private_extra: "customer data",
  }));
  const primary = new Error("PRIMARY");
  const failure = await maintenanceFailure("HEALTH_FAILED", primary, target, undefined);
  assert.equal(failure.cause, primary);
  assert.match(failure.message, /"login_visible":true/u);
  assert.match(failure.message, /"backup_region_present":false/u);
  assert.match(failure.message, /"windows_lock_state":"not_observed"/u);
  assert.doesNotMatch(failure.message, /customer data|private_extra/u);
});

test("diagnostic URL allowlist removes credentials, paths, query and fragment values", () => {
  for (const address of [
    "file:///C:/Users/secret/customer.txt",
    "https://user:password@secret.test/customer?token=abc#private",
    "data:text/plain,secret",
    "bad secret URL",
  ])
    assert.doesNotMatch(redactedPageUrl(address), /secret|customer|password|abc|private/u);
  assert.equal(
    redactedPageUrl("app://local/index.html?token=abc#private"),
    "app://local/index.html",
  );
});
