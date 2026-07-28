/**
 * Real-filesystem tests for the mock print spool.
 *
 * Every property here is a security boundary (modes, symlink refusal, atomic
 * no-replace install, fail-closed on conflict), so they run against real files
 * in a temp directory rather than a mocked fs.
 */

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createFileSpool, SpoolError } from "./file-spool.js";

const created: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "laundry-spool-"));
  created.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })));
});

const JOB_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const writeInput = (overrides: Record<string, unknown> = {}) => ({
  job_id: JOB_A,
  kind: "xp58" as const,
  seq: 1,
  content: "票号 T-1\n合计 ¥15.00\n",
  ...overrides,
});

test("writes a private artifact inside the spool root with a content hash", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool") });

  const artifact = await spool.write(writeInput());

  assert.equal(artifact.relative_path, `${JOB_A}-xp58-0001.txt`);
  assert.equal(artifact.reused, false);
  assert.equal(artifact.bytes, Buffer.from(writeInput().content, "utf8").byteLength);
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);

  const finalPath = join(spool.rootPath, artifact.relative_path);
  assert.equal(await readFile(finalPath, "utf8"), writeInput().content);
  assert.equal(((await lstat(finalPath)).mode & 0o777).toString(8), "600");
  assert.equal(((await lstat(spool.rootPath)).mode & 0o777).toString(8), "700");
});

test("leaves no staging file behind", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool") });
  const artifact = await spool.write(writeInput());
  await assert.rejects(() => lstat(join(spool.rootPath, `.${artifact.relative_path}.staging`)));
});

test("re-running an identical job reuses the artifact instead of rewriting", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool") });

  const first = await spool.write(writeInput());
  const second = await spool.write(writeInput());

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.sha256, first.sha256);
});

test("an existing artifact with different content fails closed", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool") });
  await spool.write(writeInput());

  await assert.rejects(
    () => spool.write(writeInput({ content: "tampered\n" })),
    (error: unknown) => error instanceof SpoolError && error.code === "SPOOL_ARTIFACT_CONFLICT",
  );
  // The original bytes must survive the refused write.
  assert.equal(
    await readFile(join(spool.rootPath, `${JOB_A}-xp58-0001.txt`), "utf8"),
    writeInput().content,
  );
});

test("refuses a symlinked spool root rather than following it", async () => {
  const root = await tempRoot();
  const real = join(root, "elsewhere");
  await mkdir(real, { recursive: true });
  const linked = join(root, "linked-spool");
  await symlink(real, linked);

  await assert.rejects(
    () => createFileSpool({ rootPath: linked }),
    (error: unknown) => error instanceof SpoolError && error.code === "SPOOL_ROOT_SYMLINK",
  );
});

test("refuses an existing artifact that is a symlink", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool") });
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside\n", { mode: 0o600 });
  await symlink(outside, join(spool.rootPath, `${JOB_A}-xp58-0001.txt`));

  await assert.rejects(
    () => spool.write(writeInput()),
    (error: unknown) => error instanceof SpoolError && error.code === "SPOOL_ARTIFACT_SYMLINK",
  );
  assert.equal(await readFile(outside, "utf8"), "outside\n", "target must not be written through");
});

test("derives the name only from validated identifiers", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool") });

  const rejected: readonly [Record<string, unknown>, string][] = [
    [{ job_id: "../../etc/passwd" }, "SPOOL_BAD_JOB_ID"],
    [{ job_id: `${JOB_A}/../escape` }, "SPOOL_BAD_JOB_ID"],
    [{ job_id: "not-a-uuid" }, "SPOOL_BAD_JOB_ID"],
    [{ kind: "../evil" }, "SPOOL_BAD_KIND"],
    [{ seq: 0 }, "SPOOL_BAD_SEQ"],
    [{ seq: 1.5 }, "SPOOL_BAD_SEQ"],
    [{ seq: 10_000 }, "SPOOL_BAD_SEQ"],
  ];
  for (const [overrides, code] of rejected) {
    await assert.rejects(
      () => spool.write(writeInput(overrides)),
      (error: unknown) => error instanceof SpoolError && error.code === code,
      JSON.stringify(overrides),
    );
  }
});

test("enforces the per-artifact byte cap", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool"), maxArtifactBytes: 32 });

  await assert.rejects(
    () => spool.write(writeInput({ content: "x".repeat(33) })),
    (error: unknown) => error instanceof SpoolError && error.code === "SPOOL_ARTIFACT_TOO_LARGE",
  );
  const ok = await spool.write(writeInput({ content: "x".repeat(32) }));
  assert.equal(ok.bytes, 32);
});

test("requires an absolute spool root", async () => {
  await assert.rejects(
    () => createFileSpool({ rootPath: "relative/spool" }),
    (error: unknown) => error instanceof SpoolError && error.code === "SPOOL_ROOT_RELATIVE",
  );
});

test("keeps separate jobs and attempts in separate artifacts", async () => {
  const root = await tempRoot();
  const spool = await createFileSpool({ rootPath: join(root, "spool") });

  const a1 = await spool.write(writeInput());
  const a2 = await spool.write(writeInput({ seq: 2 }));
  const b1 = await spool.write(writeInput({ job_id: JOB_B }));

  assert.equal(new Set([a1.relative_path, a2.relative_path, b1.relative_path]).size, 3);
  assert.equal(a2.relative_path, `${JOB_A}-xp58-0002.txt`);
});
