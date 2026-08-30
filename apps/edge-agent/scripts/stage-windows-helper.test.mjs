import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { stageWindowsHelper } from "./stage-windows-helper.mjs";

const HELPER_FILE_NAME = "laundry-windows-helper.exe";

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-windows-helper-stage-"));
  t.after(async () => await rm(root, { force: true, recursive: true }));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "output", "windows-helper");
  await Promise.all([mkdir(sourceRoot), mkdir(join(root, "output"))]);
  const helper = Buffer.from("fixture-windows-helper\n", "utf8");
  const digest = createHash("sha256").update(helper).digest("hex");
  await Promise.all([
    writeFile(join(sourceRoot, HELPER_FILE_NAME), helper),
    writeFile(join(sourceRoot, `${HELPER_FILE_NAME}.sha256`), `${digest}\n`, "ascii"),
  ]);
  return { digest, root, sourceRoot, targetRoot };
}

test("stages only a digest-bound Windows helper bundle", async (t) => {
  const fixture = await createFixture(t);

  const result = await stageWindowsHelper(fixture);

  assert.equal(result.digest, fixture.digest);
  assert.equal(result.targetRoot, fixture.targetRoot);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(fixture.targetRoot, HELPER_FILE_NAME)))
      .digest("hex"),
    fixture.digest,
  );
});

test("rejects a digest mismatch without replacing an existing staged helper", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(fixture.targetRoot);
  await writeFile(join(fixture.targetRoot, "sentinel"), "keep\n");
  await writeFile(join(fixture.sourceRoot, `${HELPER_FILE_NAME}.sha256`), `${"0".repeat(64)}\n`);

  await assert.rejects(() => stageWindowsHelper(fixture), /STAGING_INTEGRITY_FAILED/u);

  assert.equal(await readFile(join(fixture.targetRoot, "sentinel"), "utf8"), "keep\n");
});

test("rejects a multiply-linked helper source", async (t) => {
  const fixture = await createFixture(t);
  await link(join(fixture.sourceRoot, HELPER_FILE_NAME), join(fixture.root, "linked-helper.exe"));

  await assert.rejects(() => stageWindowsHelper(fixture), /STAGING_FILE_INVALID/u);
});
