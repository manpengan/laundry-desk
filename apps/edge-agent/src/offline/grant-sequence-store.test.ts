import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileGrantSequenceStore } from "./grant-sequence-store.js";

const GRANT_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const OTHER_GRANT_ID = "51a2eed0-a6c3-493c-a3a7-20bf94b1d678";

test("reserves and commits contiguous per-grant sequences before reusing them after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-grant-sequence-"));
  try {
    const first = new FileGrantSequenceStore(root);
    assert.equal(first.reserve(GRANT_ID), 1);
    first.commit(GRANT_ID, 1);
    assert.equal(first.reserve(GRANT_ID), 2);
    first.commit(GRANT_ID, 2);

    const restarted = new FileGrantSequenceStore(root);
    assert.equal(restarted.reserve(GRANT_ID), 3);
    restarted.commit(GRANT_ID, 3);
    assert.equal(restarted.reserve(OTHER_GRANT_ID), 1);
    restarted.commit(OTHER_GRANT_ID, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed after a crash leaves a pre-enqueue reservation pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-grant-sequence-"));
  try {
    const first = new FileGrantSequenceStore(root);
    assert.equal(first.reserve(GRANT_ID), 1);

    const restarted = new FileGrantSequenceStore(root);
    assert.throws(() => restarted.reserve(GRANT_ID), /pending/u);
    assert.equal(restarted.reserve(OTHER_GRANT_ID), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy crash lock cannot permanently block a safely recoverable new process", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-grant-sequence-"));
  try {
    const first = new FileGrantSequenceStore(root);
    assert.equal(first.reserve(GRANT_ID), 1);
    first.commit(GRANT_ID, 1);
    await writeFile(join(root, ".offline-grant-sequences.lock"), "stale\n", {
      encoding: "utf8",
      mode: 0o600,
    });

    const restarted = new FileGrantSequenceStore(root);
    assert.equal(restarted.reserve(OTHER_GRANT_ID), 1);
    restarted.commit(OTHER_GRANT_ID, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects a valid-looking sequence-file rollback and corrupted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-grant-sequence-"));
  const path = join(root, "offline-grant-sequences.json");
  try {
    const store = new FileGrantSequenceStore(root);
    assert.equal(store.reserve(GRANT_ID), 1);
    store.commit(GRANT_ID, 1);
    const oldState = await readFile(path, "utf8");
    assert.equal(store.reserve(GRANT_ID), 2);
    store.commit(GRANT_ID, 2);

    await writeFile(path, oldState, { encoding: "utf8", mode: 0o600 });
    assert.throws(() => store.reserve(GRANT_ID), /rollback/u);

    await writeFile(path, "{not-json}\n", { encoding: "utf8", mode: 0o600 });
    assert.throws(() => new FileGrantSequenceStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlink, hardlink, and non-private sequence state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-grant-sequence-security-"));
  const path = join(root, "offline-grant-sequences.json");
  try {
    const store = new FileGrantSequenceStore(root);
    assert.equal(store.reserve(GRANT_ID), 1);
    store.commit(GRANT_ID, 1);

    await t.test("symlink", async () => {
      const backing = join(root, "sequence-backing.json");
      await rename(path, backing);
      await symlink(backing, path);
      assert.throws(() => new FileGrantSequenceStore(root), /Invalid offline grant sequence file/u);
      await unlink(path);
      await rename(backing, path);
    });

    await t.test("hardlink", async () => {
      const alias = join(root, "sequence-hardlink.json");
      await link(path, alias);
      assert.throws(() => new FileGrantSequenceStore(root), /Invalid offline grant sequence file/u);
      await unlink(alias);
    });

    await t.test("mode", async () => {
      await chmod(path, 0o644);
      assert.throws(() => new FileGrantSequenceStore(root), /Invalid offline grant sequence file/u);
      await chmod(path, 0o600);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
