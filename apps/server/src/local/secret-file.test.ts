import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { securePrivateFile } from "@laundry/platform-fs";

import { readSecretValue } from "./secret-file.js";

test("reads an absolute regular secret file without exposing it through process env", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-secret-file-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const path = join(root, "access-token");
  const secret = "secret-file-value-is-at-least-thirty-two-bytes";
  await writeFile(path, secret, { mode: 0o600 });
  await securePrivateFile(path);

  assert.equal(
    readSecretValue({ LAUNDRY_ACCESS_TOKEN_SECRET_FILE: path }, "LAUNDRY_ACCESS_TOKEN_SECRET"),
    secret,
  );
});

test("fails closed for ambiguous, linked, multiline, and oversized secret sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-secret-invalid-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const regular = join(root, "regular");
  const linked = join(root, "linked");
  const multiline = join(root, "multiline");
  const oversized = join(root, "oversized");
  await writeFile(regular, "safe-secret-value", { mode: 0o600 });
  await securePrivateFile(regular);
  await symlink(regular, linked);
  await writeFile(multiline, "secret\nsecond-line", { mode: 0o600 });
  await securePrivateFile(multiline);
  await writeFile(oversized, "x".repeat(16_385), { mode: 0o600 });
  await securePrivateFile(oversized);

  assert.throws(
    () =>
      readSecretValue(
        { LAUNDRY_ACCESS_TOKEN_SECRET: "direct", LAUNDRY_ACCESS_TOKEN_SECRET_FILE: regular },
        "LAUNDRY_ACCESS_TOKEN_SECRET",
      ),
    /SECRET_SOURCE_AMBIGUOUS/u,
  );
  for (const path of [linked, multiline, oversized]) {
    assert.throws(
      () =>
        readSecretValue({ LAUNDRY_ACCESS_TOKEN_SECRET_FILE: path }, "LAUNDRY_ACCESS_TOKEN_SECRET"),
      /SECRET_FILE_INVALID/u,
    );
  }
});

test("optional secret sources remain absent and invalid paths are redacted", () => {
  assert.equal(readSecretValue({}, "DATABASE_URL"), undefined);
  const sentinel = "/private/sentinel/database-url";
  assert.throws(
    () => readSecretValue({ DATABASE_URL_FILE: sentinel }, "DATABASE_URL"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SECRET_FILE_INVALID/u);
      assert.doesNotMatch(error.message, /sentinel/u);
      return true;
    },
  );
});
