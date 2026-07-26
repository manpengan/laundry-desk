import assert from "node:assert/strict";
import test from "node:test";

import type { LocalRuntime } from "../local/create-runtime.js";
import { createHttpRuntime } from "./http-runtime.js";

const FAKE_RUNTIME = Object.freeze({ mode: "pg" }) as LocalRuntime;

test("listenable HTTP runtime fails closed without an explicit app-role DATABASE_URL", async () => {
  let factoryCalls = 0;
  const createRuntime = async (): Promise<LocalRuntime> => {
    factoryCalls += 1;
    return FAKE_RUNTIME;
  };

  for (const env of [
    {},
    { DATABASE_URL: "" },
    { DATABASE_URL: "   " },
    { LAUNDRY_CONTAINER_RUNTIME: "1" },
    {
      LAUNDRY_CONTAINER_RUNTIME: "1",
      LAUNDRY_USE_LOCAL_PG: "1",
      LAUNDRY_PG_APP_URL: "postgresql://laundry_app:secret@postgres/laundry_v2",
    },
  ]) {
    await assert.rejects(
      () => createHttpRuntime(env, { createRuntime }),
      /HTTP runtime requires an explicit laundry_app DATABASE_URL/u,
    );
  }
  assert.equal(factoryCalls, 0);
});

test("listenable HTTP runtime delegates only after an explicit DATABASE_URL", async () => {
  const received: NodeJS.ProcessEnv[] = [];
  const env = Object.freeze({
    DATABASE_URL: "postgresql://laundry_app:secret@postgres/laundry_v2",
    LAUNDRY_CONTAINER_RUNTIME: "1",
  });

  const runtime = await createHttpRuntime(env, {
    createRuntime: async (input) => {
      received.push(input);
      return FAKE_RUNTIME;
    },
  });

  assert.equal(runtime, FAKE_RUNTIME);
  assert.deepEqual(received, [env]);
});
