import assert from "node:assert/strict";
import test from "node:test";

import { FakeSqlClient } from "../db/fake-client.js";
import { acquirePgBusinessDayLock } from "./business-day-lock.js";

test("business-day advisory lock binds one opaque tenant/day key", async () => {
  const client = new FakeSqlClient();
  await acquirePgBusinessDayLock(
    client,
    {
      orgId: "10000000-0000-4000-8000-000000000001",
      storeId: "10000000-0000-4000-8000-000000000002",
      staffId: "10000000-0000-4000-8000-000000000003",
    },
    "2026-07-30",
  );
  assert.deepEqual(client.queries, [
    {
      sql: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      params: [
        "laundry:business-day:10000000-0000-4000-8000-000000000001:10000000-0000-4000-8000-000000000002:2026-07-30",
      ],
    },
  ]);
});
