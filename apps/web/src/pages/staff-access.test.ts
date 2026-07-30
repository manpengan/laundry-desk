import assert from "node:assert/strict";
import test from "node:test";

import { parseStaffAccessRows } from "./staff-access.js";

test("parseStaffAccessRows accepts the bounded query projection", () => {
  const rows = parseStaffAccessRows({
    execution: "executed",
    result: {
      staff: [
        {
          staff_id: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
          username: "admin",
          display_name: "店长",
          role: "admin",
          privacy_admin: true,
          is_active: true,
          permission_version: 2,
        },
      ],
    },
  });
  assert.equal(rows?.[0]?.privacy_admin, true);
  assert.equal(Object.isFrozen(rows), true);
});

test("parseStaffAccessRows rejects malformed authority fields", () => {
  assert.equal(
    parseStaffAccessRows({
      execution: "executed",
      result: {
        staff: [
          {
            staff_id: "id",
            username: "admin",
            display_name: "店长",
            role: "owner",
            privacy_admin: "yes",
            is_active: true,
            permission_version: 0,
          },
        ],
      },
    }),
    null,
  );
});
