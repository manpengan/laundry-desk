import assert from "node:assert/strict";
import test from "node:test";

import type { SessionView } from "../auth/types.js";
import { createDesktopPorts, type LaundryDesktopBridge } from "./desktop-ports.js";

type CredentialInput = Parameters<
  NonNullable<LaundryDesktopBridge["auth"]["credentialComplete"]>
>[0];
type QueryInput = Parameters<LaundryDesktopBridge["query"]["execute"]>[0];

const STAFF_ID = "11111111-1111-4111-8111-111111111103";
const NEW_STAFF_ID = "11111111-1111-4111-8111-111111111104";
const SETUP_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const SESSION: SessionView = Object.freeze({
  session: Object.freeze({
    session_id: "22222222-2222-4222-8222-222222222222",
    session_version: 1,
    org_id: "33333333-3333-4333-8333-333333333333",
    store_id: "44444444-4444-4444-8444-444444444444",
    staff_id: STAFF_ID,
    device_id: "55555555-5555-4555-8555-555555555555",
    permission_version: 2,
  }),
  role: "admin",
  features: Object.freeze({ member_enabled: true }),
  display: Object.freeze({
    store_name: "本地门店",
    staff_name: "本地管理员",
    org_code: "local",
    store_code: "main",
  }),
});

function bridgeWithStaffOperations(captured: unknown[]): LaundryDesktopBridge {
  return Object.freeze({
    auth: Object.freeze({
      login: async () => ({
        ok: true,
        data: {
          session_view: SESSION,
          staff_directory: [{ staff_id: STAFF_ID, display_name: "本地管理员", role: "admin" }],
        },
      }),
      refresh: async () => ({ ok: true, data: SESSION }),
      pinChallenge: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      pinVerify: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
      credentialComplete: async (input: CredentialInput) => {
        captured.push(input);
        return {
          ok: true,
          data: { target_staff_id: NEW_STAFF_ID, permission_version: 1, status: "active" },
        };
      },
      logout: async () => ({ ok: true, data: { logged_out: true } }),
    }),
    command: Object.freeze({
      execute: async () => ({ ok: false, error: { code: "UNUSED", message: "unused" } }),
    }),
    query: Object.freeze({
      execute: async (input: QueryInput) => {
        captured.push(input);
        return {
          ok: true,
          data: {
            result: {
              staff: [
                {
                  staff_id: STAFF_ID,
                  display_name: "本地管理员",
                  role: "admin",
                  is_active: true,
                },
                {
                  staff_id: NEW_STAFF_ID,
                  display_name: "新员工",
                  role: "staff",
                  is_active: true,
                },
              ],
            },
          },
        };
      },
    }),
    health: Object.freeze({ get: async () => ({ ok: true, data: { status: "ready" } }) }),
  });
}

test("desktop staff credential completion returns no secret and refreshes the directory", async () => {
  const captured: unknown[] = [];
  const ports = createDesktopPorts(bridgeWithStaffOperations(captured));
  const input = Object.freeze({
    credential_setup_ref: SETUP_REF,
    password: "correct-horse-battery",
    pin: "864209",
  });

  const completed = await ports.auth.completeStaffCredentials(input);
  assert.equal(completed.ok, true);
  assert.doesNotMatch(
    JSON.stringify(completed),
    /correct-horse-battery|864209|password|pin|credential_setup_ref/iu,
  );

  const refreshed = await ports.auth.refreshSession();
  assert.equal(refreshed.ok, true);
  assert.deepEqual(ports.auth.listSwitchableStaff(), [
    { staff_id: STAFF_ID, display_name: "本地管理员", role: "admin" },
    { staff_id: NEW_STAFF_ID, display_name: "新员工", role: "staff" },
  ]);
  assert.deepEqual(captured, [input, { name: "staff.access.list", body: {} }]);
});
