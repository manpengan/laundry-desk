import test from "node:test";
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { backupFixture } from "./backup-test-fixture.mjs";
import { streamPostgres } from "./backup-process.mjs";
import { MAX_DUMP_BYTES } from "./backup-contract.mjs";

test("database output streams to a held private file instead of a diagnostic buffer", async (t) => {
  const context = await backupFixture(t);
  const path = join(context.root, "dump");
  const file = await open(path, "wx", 0o600);
  try {
    await streamPostgres(
      process.execPath,
      [
        "-e",
        "process.stdout.write(Buffer.alloc(131072,65));process.stderr.write('secret native diagnostic')",
      ],
      process.env,
      context.root,
      { output: file },
    );
    await file.sync();
    assert.equal((await file.stat()).size, 131072);
    assert.deepEqual(await readFile(path), Buffer.alloc(131072, 65));
  } finally {
    await file.close();
  }
});

test("native process failure returns a stable error without echoing its stderr", async (t) => {
  const context = await backupFixture(t);
  await assert.rejects(
    streamPostgres(
      process.execPath,
      ["-e", "process.stderr.write('private database URL');process.exit(9)"],
      process.env,
      context.root,
    ),
    (error) => {
      assert.equal(error.message, "WINDOWS_COMPANION_BACKUP_PROCESS_FAILED");
      return true;
    },
  );
});

test("dump size monitoring terminates the native writer without publishing oversized data", async (t) => {
  const context = await backupFixture(t);
  const file = await open(join(context.root, "oversized"), "wx", 0o600);
  try {
    await file.truncate(MAX_DUMP_BYTES + 1);
    await assert.rejects(
      streamPostgres(
        process.execPath,
        ["-e", "setTimeout(()=>{},10000)"],
        process.env,
        context.root,
        { output: file },
      ),
      /BACKUP_DUMP_TOO_LARGE/u,
    );
  } finally {
    await file.close();
  }
});
