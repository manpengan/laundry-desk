import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_PROFILE } from "./profile.js";

test("freezes the one generic local profile", () => {
  assert.deepEqual(LOCAL_PROFILE, {
    orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    adminStaffId: "11111111-1111-4111-8111-111111111103",
    orgCode: "local",
    storeCode: "main",
    orgName: "laundry-desk V2",
    storeName: "本地门店",
    timezone: "Asia/Taipei",
  });
  assert.equal(Object.isFrozen(LOCAL_PROFILE), true);
});

test("uses an explicit valid IANA timezone", () => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: LOCAL_PROFILE.timezone,
  });

  assert.equal(formatter.resolvedOptions().timeZone, "Asia/Taipei");
});
