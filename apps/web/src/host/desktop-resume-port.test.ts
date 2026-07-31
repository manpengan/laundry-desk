import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../auth/types.js";
import { createDesktopResumePort } from "./desktop-resume-port.js";

const SESSION: SessionView = Object.freeze({
  session: Object.freeze({
    session_id: "10000000-0000-4000-8000-000000000001",
    session_version: 1,
    org_id: "10000000-0000-4000-8000-000000000002",
    store_id: "10000000-0000-4000-8000-000000000003",
    staff_id: "10000000-0000-4000-8000-000000000004",
    device_id: "10000000-0000-4000-8000-000000000005",
    permission_version: 1,
  }),
  role: "staff",
  features: Object.freeze({ member_enabled: true }),
  display: Object.freeze({
    store_name: "本地门店",
    staff_name: "店员",
    org_code: "local",
    store_code: "main",
  }),
});

function offlineSurface(resume: () => Promise<unknown>) {
  return Object.freeze({
    resume,
    status: async () => ({ ok: false }),
    resolve: async () => ({ ok: false }),
  });
}

test("desktop resume adapter accepts strict token-free online and offline views", async () => {
  const online = createDesktopResumePort(
    offlineSurface(async () => ({
      ok: true,
      data: { mode: "online", session_view: SESSION },
    })),
  );
  const offline = createDesktopResumePort(
    offlineSurface(async () => ({
      ok: true,
      data: {
        mode: "offline_read_only",
        session_view: SESSION,
        cached_query_count: 4,
        grant_not_after: "2026-07-30T12:00:00.000Z",
      },
    })),
  );

  assert.deepEqual(await online?.resume(), {
    ok: true,
    session: SESSION,
    mode: "online",
  });
  const resumed = await offline?.resume();
  assert.deepEqual(resumed, {
    ok: true,
    session: SESSION,
    mode: "offline_read_only",
  });
  assert.doesNotMatch(
    JSON.stringify(resumed),
    /access_token|refresh_token|authorization|cookie|password|pin|secret/iu,
  );
});

test("desktop resume adapter rejects credential-bearing, expanded, and malformed payloads", async () => {
  const unsafe = [
    {
      ok: true,
      data: {
        mode: "offline_read_only",
        session_view: { ...SESSION, access_token: "must.not.escape" },
        cached_query_count: 1,
        grant_not_after: "2026-07-30T12:00:00.000Z",
      },
    },
    {
      ok: true,
      data: {
        mode: "online",
        session_view: SESSION,
        extra: true,
      },
    },
    {
      ok: true,
      data: {
        mode: "offline_read_only",
        session_view: SESSION,
        cached_query_count: 0,
        grant_not_after: "invalid",
      },
    },
  ];

  for (const value of unsafe) {
    const port = createDesktopResumePort(offlineSurface(async () => value));
    assert.deepEqual(await port?.resume(), { ok: false });
  }
});
