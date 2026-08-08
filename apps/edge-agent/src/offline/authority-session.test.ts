import assert from "node:assert/strict";
import test from "node:test";

import { DesktopSessionViewSchema, type DesktopSessionView } from "@laundry/contracts";

import { authorityCanRebindSession, bindAuthoritySession } from "./authority-session.js";

const session = DesktopSessionViewSchema.parse({
  session: {
    session_id: "10000000-0000-4000-8000-000000000001",
    session_version: 1,
    org_id: "10000000-0000-4000-8000-000000000002",
    store_id: "10000000-0000-4000-8000-000000000003",
    staff_id: "10000000-0000-4000-8000-000000000004",
    device_id: "10000000-0000-4000-8000-000000000005",
    permission_version: 1,
  },
  role: "staff",
  features: { member_enabled: true },
  display: {
    store_name: "本地门店",
    staff_name: "店员",
    org_code: "local",
    store_code: "main",
  },
});

function changeSession(
  patch: Partial<DesktopSessionView["session"]>,
  role: DesktopSessionView["role"] = session.role,
): DesktopSessionView {
  return DesktopSessionViewSchema.parse({
    ...session,
    role,
    session: { ...session.session, ...patch },
  });
}

test("session authority can rebind only across token identity rotation", () => {
  const binding = bindAuthoritySession(session);
  assert.equal(
    authorityCanRebindSession(
      binding,
      changeSession({
        session_id: "20000000-0000-4000-8000-000000000001",
        session_version: 2,
      }),
    ),
    true,
  );

  const authorityChanges: DesktopSessionView[] = [
    changeSession({ org_id: "20000000-0000-4000-8000-000000000002" }),
    changeSession({ store_id: "20000000-0000-4000-8000-000000000003" }),
    changeSession({ staff_id: "20000000-0000-4000-8000-000000000004" }),
    changeSession({ device_id: "20000000-0000-4000-8000-000000000005" }),
    changeSession({ permission_version: 2 }),
    changeSession({}, "admin"),
  ];
  assert.ok(authorityChanges.every((next) => !authorityCanRebindSession(binding, next)));
});
