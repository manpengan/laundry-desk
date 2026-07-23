import assert from "node:assert/strict";
import test from "node:test";

import { createLocalRuntime } from "./create-runtime.js";

test("production runtime refuses the process-memory fallback without laundry_app DATABASE_URL", async () => {
  await assert.rejects(
    () => createLocalRuntime({ NODE_ENV: "production" }),
    /Production runtime requires DATABASE_URL for the laundry_app role/u,
  );
});

test("production runtime rejects an admin-only URL instead of using it as the app role", async () => {
  await assert.rejects(
    () =>
      createLocalRuntime({
        NODE_ENV: "production",
        DATABASE_ADMIN_URL: "postgresql://owner:owner@localhost:5432/laundry_v2",
      }),
    /Production runtime requires DATABASE_URL for the laundry_app role/u,
  );
});
