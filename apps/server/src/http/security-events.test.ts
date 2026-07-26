import assert from "node:assert/strict";
import test from "node:test";

import { createSecurityEventSink, type SecurityEventLogRecord } from "./security-events.js";

const KEY = "security-event-test-key-with-32-bytes-minimum";

test("security events contain only fixed reason, request id, and opaque dimension refs", () => {
  const logged: unknown[] = [];
  const sink = createSecurityEventSink(KEY);
  const request = Object.freeze({
    id: "req-17",
    log: Object.freeze({
      warn: (record: unknown): void => {
        logged.push(record);
      },
    }),
  });

  sink.record(request, {
    reason: "LOGIN_FAILED",
    account: Object.freeze({
      org_code: "sentinel-org",
      store_code: "sentinel-store",
      username: "sentinel-user",
    }),
    ip: "192.0.2.44",
  });

  assert.equal(logged.length, 1);
  const event = logged[0] as { security_event: SecurityEventLogRecord };
  assert.equal(Object.isFrozen(event.security_event), true);
  assert.deepEqual(Object.keys(event.security_event).sort(), [
    "account_ref",
    "event",
    "ip_ref",
    "reason_code",
    "request_id",
  ]);
  assert.equal(event.security_event.event, "authentication_security");
  assert.equal(event.security_event.reason_code, "LOGIN_FAILED");
  assert.equal(event.security_event.request_id, "req-17");
  assert.match(event.security_event.account_ref ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.match(event.security_event.ip_ref ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(event.security_event.account_ref, event.security_event.ip_ref);
  assert.doesNotMatch(JSON.stringify(logged), /sentinel|192\.0\.2\.44/u);
});

test("session references are stable per key and namespaced from other dimensions", () => {
  const logged: { security_event: SecurityEventLogRecord }[] = [];
  const sink = createSecurityEventSink(KEY);
  const request = {
    id: "req-18",
    log: {
      warn: (record: unknown): void => {
        logged.push(record as { security_event: SecurityEventLogRecord });
      },
    },
  };
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  sink.record(request, { reason: "CSRF_REJECTED", session_id: sessionId });
  sink.record(request, { reason: "REFRESH_REJECTED", session_id: sessionId });

  assert.equal(logged[0]?.security_event.session_ref, logged[1]?.security_event.session_ref);
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(sessionId, "u"));
});

test("PIN failure and lockout events expose only a stable opaque staff reference", () => {
  const logged: { security_event: SecurityEventLogRecord }[] = [];
  const sink = createSecurityEventSink(KEY);
  const request = {
    id: "req-pin",
    log: {
      warn: (record: unknown): void => {
        logged.push(record as { security_event: SecurityEventLogRecord });
      },
    },
  };
  const staffId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  sink.record(request, { reason: "PIN_FAILED", staff_id: staffId });
  sink.record(request, { reason: "PIN_LOCKED", staff_id: staffId });

  assert.equal(logged[0]?.security_event.staff_ref, logged[1]?.security_event.staff_ref);
  assert.match(logged[0]?.security_event.staff_ref ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.doesNotMatch(JSON.stringify(logged), new RegExp(staffId, "u"));
});

test("sink rejects weak keys, unknown fields, and unbounded dimensions", () => {
  assert.throws(() => createSecurityEventSink("short"), /security event key/u);
  const sink = createSecurityEventSink(KEY);
  const request = { id: "req", log: { warn: (): void => undefined } };

  assert.throws(() =>
    sink.record(request, {
      reason: "LOGIN_FAILED",
      password: "must-not-log",
    } as never),
  );
  assert.throws(() =>
    sink.record(request, {
      reason: "CSRF_REJECTED",
      session_id: "a".repeat(513),
    }),
  );
});
