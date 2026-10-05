import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWindowsHelper, publishWindowsHelper } from "./build-windows-helper.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "laundry-helper-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "laundry-windows-helper.exe");
  const temporary = join(root, "compiled.tmp.exe");
  const bytes = Buffer.from("new compiled helper");
  await writeFile(temporary, bytes);
  return { root, output, temporary, bytes, sidecar: `${output}.sha256` };
}

for (const linked of [false, true]) {
  test(`publishes independent helper files ${linked ? "after hardlinked deployment" : "on first build"}`, async (t) => {
    const { root, output, temporary, bytes, sidecar } = await fixture(t);
    const oldHelper = Buffer.from("previous compiled helper");
    const oldDigest = `${createHash("sha256").update(oldHelper).digest("hex")}\n`;
    const aliases = [];
    if (linked) {
      await writeFile(output, oldHelper);
      await writeFile(sidecar, oldDigest);
      await link(output, join(root, "deployed-helper.exe"));
      for (let index = 0; index < 5; index += 1) {
        const alias = join(root, `deployed-${index}.sha256`);
        await link(sidecar, alias);
        aliases.push(alias);
      }
      assert.equal((await lstat(output)).nlink, 2);
      assert.equal((await lstat(sidecar)).nlink, 6);
    }

    const digest = await publishWindowsHelper(temporary, output);
    assert.equal(digest, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(await readFile(output), bytes);
    assert.equal(await readFile(sidecar, "ascii"), `${digest}\n`);
    for (const path of [output, sidecar]) {
      const metadata = await lstat(path);
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.nlink, 1);
    }
    if (linked) {
      assert.deepEqual(await readFile(join(root, "deployed-helper.exe")), oldHelper);
      for (const alias of aliases) assert.equal(await readFile(alias, "ascii"), oldDigest);
    }
    assert.equal(
      (await readdir(root)).some((name) => name.includes(".tmp")),
      false,
    );
  });
}

test("digest publication failure rejects and removes only its temporary sidecar", async (t) => {
  const { root, output, temporary, sidecar } = await fixture(t);
  await mkdir(sidecar);
  await writeFile(join(sidecar, "keep"), "preserved");
  await assert.rejects(publishWindowsHelper(temporary, output));
  assert.equal(await readFile(join(sidecar, "keep"), "utf8"), "preserved");
  assert.equal(
    (await readdir(root)).some((name) => name.includes(".tmp")),
    false,
  );
});

test("non-Windows builds still skip the native compiler", async () => {
  const result = await buildWindowsHelper({}, "darwin");
  assert.deepEqual(result, { built: false });
  assert.equal(Object.isFrozen(result), true);
});
