import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { securePrivateFile } from "@laundry/platform-fs";

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

test("listenable HTTP runtime accepts one strict DATABASE_URL_FILE", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-http-runtime-secret-"));
  const path = join(root, "database-url");
  const env = Object.freeze({ DATABASE_URL_FILE: path, LAUNDRY_CONTAINER_RUNTIME: "1" });
  await writeFile(path, "postgresql://laundry_app:secret@postgres/laundry_v2", { mode: 0o600 });
  await securePrivateFile(path);
  try {
    const received: NodeJS.ProcessEnv[] = [];
    const runtime = await createHttpRuntime(env, {
      createRuntime: async (input) => {
        received.push(input);
        return FAKE_RUNTIME;
      },
    });
    assert.equal(runtime, FAKE_RUNTIME);
    assert.deepEqual(received, [env]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listenable HTTP runtime rejects ambiguous and unsafe DATABASE_URL_FILE inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-http-runtime-invalid-secret-"));
  const regular = join(root, "regular");
  const linked = join(root, "linked");
  const multiline = join(root, "multiline");
  await writeFile(regular, "postgresql://laundry_app:secret@postgres/laundry_v2", { mode: 0o600 });
  await securePrivateFile(regular);
  await symlink(regular, linked);
  await writeFile(multiline, "postgresql://laundry_app:secret@postgres/laundry_v2\n", {
    mode: 0o600,
  });
  await securePrivateFile(multiline);
  let factoryCalls = 0;
  const createRuntime = async (): Promise<LocalRuntime> => {
    factoryCalls += 1;
    return FAKE_RUNTIME;
  };
  try {
    for (const env of [
      { DATABASE_URL_FILE: linked },
      { DATABASE_URL_FILE: multiline },
      {
        DATABASE_URL: "postgresql://laundry_app:direct@postgres/laundry_v2",
        DATABASE_URL_FILE: regular,
      },
    ]) {
      await assert.rejects(
        () => createHttpRuntime(env, { createRuntime }),
        /SECRET_(?:FILE_INVALID|SOURCE_AMBIGUOUS)/u,
      );
    }
    assert.equal(factoryCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
