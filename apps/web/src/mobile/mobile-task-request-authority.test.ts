import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../auth/types.js";
import {
  createMobileTaskRequestAuthority,
  mobileTaskSessionScope,
} from "./mobile-task-request-authority.js";

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

function session(overrides: Partial<SessionView["session"]> = {}): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "11111111-1111-4111-8111-111111111111",
      session_version: 1,
      org_id: "22222222-2222-4222-8222-222222222222",
      store_id: "33333333-3333-4333-8333-333333333333",
      staff_id: "44444444-4444-4444-8444-444444444444",
      device_id: "55555555-5555-4555-8555-555555555555",
      permission_version: 1,
      ...overrides,
    }),
    role: "staff",
    features: Object.freeze({ delivery_enabled: true }),
    display: Object.freeze({
      store_name: "门店",
      staff_name: "员工",
      org_code: "org",
      store_code: "store",
    }),
  });
}

test("a newer request aborts and supersedes the prior generation on its channel", () => {
  const authority = createMobileTaskRequestAuthority(mobileTaskSessionScope(session()));
  const first = authority.begin("detail", "task-a:v1");
  const list = authority.begin("list", "mine:active");
  const second = authority.begin("detail", "task-b:v1");

  assert.equal(first.signal.aborted, true);
  assert.equal(authority.isCurrent(first), false);
  assert.equal(authority.isCurrent(second), true);
  assert.equal(authority.isCurrent(list), true, "channels must remain independently owned");
});

test("generation rejection protects state even when a deferred port ignores AbortSignal", async () => {
  const authority = createMobileTaskRequestAuthority(mobileTaskSessionScope(session()));
  const response = deferred<string>();
  const token = authority.begin("detail", "task-a:v1");
  const accepted: string[] = [];
  const read = response.promise.then((value) => {
    if (authority.isCurrent(token)) accepted.push(value);
  });

  authority.invalidate("detail");
  response.resolve("old-order-pii");
  await read;

  assert.equal(token.signal.aborted, true);
  assert.deepEqual(accepted, []);
});

test("session, store, staff and permission changes create a new authority scope", () => {
  const originalScope = mobileTaskSessionScope(session());
  const changedScopes = [
    mobileTaskSessionScope(session({ session_id: "66666666-6666-4666-8666-666666666666" })),
    mobileTaskSessionScope(session({ store_id: "77777777-7777-4777-8777-777777777777" })),
    mobileTaskSessionScope(session({ staff_id: "88888888-8888-4888-8888-888888888888" })),
    mobileTaskSessionScope(session({ permission_version: 2 })),
  ];
  const oldAuthority = createMobileTaskRequestAuthority(originalScope);
  const oldDetail = oldAuthority.begin("detail", "task-a:v1");
  const oldConfirmation = oldAuthority.begin("mutation", "confirm-ref-a");

  oldAuthority.invalidateAll();

  assert.ok(changedScopes.every((scope) => scope !== originalScope));
  assert.equal(oldAuthority.isCurrent(oldDetail), false);
  assert.equal(oldAuthority.isCurrent(oldConfirmation), false);
  assert.equal(oldDetail.signal.aborted, true);
  assert.equal(oldConfirmation.signal.aborted, true);
});
