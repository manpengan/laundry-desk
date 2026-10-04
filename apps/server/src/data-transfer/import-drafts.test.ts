import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createImportDraftStore,
  importRequestPaths,
  openImportRequestRoot,
} from "./import-drafts.js";
import {
  cleanupImportRequest,
  cleanupStaleImportMaterials,
  IMPORT_REQUEST_MARKER,
  importRequestMarker,
} from "./import-cleanup.js";

const require = createRequire(import.meta.url);
const nativeRequire = createRequire(require.resolve("@laundry/migrate-v1"));
const Database = nativeRequire("better-sqlite3") as new (path: string) => {
  exec: (sql: string) => void;
  close: () => void;
};
const fixtureSql = new URL(
  "../../../../tools/migrate-v1/test/fixtures/v1-fixture.sql",
  import.meta.url,
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "laundry-v1-draft-")));
  const source = join(directory, "synthetic.db");
  const db = new Database(source);
  db.exec(await readFile(fixtureSql, "utf8"));
  db.close();
  return { directory, source, root: join(directory, "requests"), bytes: await readFile(source) };
}

test("private draft binds source, photos, review and one approval to the authenticated session", async () => {
  const f = await fixture();
  try {
    let now = Date.now();
    const store = await createImportDraftStore(f.root, () => now);
    const draft = await store.create("first-session", f.bytes);
    assert.equal(draft.report.isZeroDifference, true);
    assert.equal(draft.report.target.orders, 2);
    assert.equal(draft.photos.length, 1);
    await assert.rejects(store.review("other-session", draft.draft_id), /UNAVAILABLE/);
    await assert.rejects(store.review("first-session", draft.draft_id), /ENOENT/);
    await assert.rejects(
      store.uploadPhoto("first-session", draft.draft_id, randomUUID(), jpeg),
      /INVALID/,
    );
    const photo = draft.photos[0]!;
    await store.uploadPhoto("first-session", draft.draft_id, photo.id, jpeg);
    // Duplicate references may share a file; exact retries never replace bytes.
    await store.uploadPhoto("first-session", draft.draft_id, photo.id, jpeg);
    await assert.rejects(
      store.uploadPhoto("first-session", draft.draft_id, photo.id, Buffer.from("different")),
      /CONFLICT/,
    );
    const review = await store.review("first-session", draft.draft_id);
    assert.match(review.photos_sha256, /^[0-9a-f]{64}$/u);
    let approved = 0;
    const result = await store.approve("first-session", draft.draft_id, async (actual) => {
      assert.deepEqual(actual, review);
      approved += 1;
      return now + 60_000;
    });
    assert.equal(result.request_id, draft.draft_id);
    await assert.rejects(
      store.approve("first-session", draft.draft_id, async () => now),
      /UNAVAILABLE/,
    );
    assert.equal(approved, 1);
    now += 61_000;
    await store.prune();
    assert.ok((await readdir(f.root)).includes(draft.draft_id));
    await cleanupImportRequest(f.root, draft.draft_id);
    assert.equal((await readdir(f.root)).includes(draft.draft_id), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("draft rejects malformed data and unknown mappings, expires locally, and cleans crash leftovers only when marked", async () => {
  const f = await fixture();
  try {
    let now = Date.now();
    const store = await createImportDraftStore(f.root, () => now);
    await assert.rejects(store.create("s", Buffer.from("not sqlite")), /SOURCE_INVALID/);
    const draft = await store.create("s", f.bytes);
    now += 31 * 60_000;
    await assert.rejects(store.review("s", draft.draft_id), /UNAVAILABLE/);
    await store.prune();
    assert.equal((await readdir(f.root)).includes(draft.draft_id), false);
    const db = new Database(f.source);
    db.exec("INSERT INTO settings VALUES ('unsupported.setting','value',NULL)");
    db.close();
    await assert.rejects(store.create("s", await readFile(f.source)), /SETTING_MAPPING_REQUIRED/);
    assert.equal((await readdir(f.root)).filter((n) => /^[0-9a-f-]{36}$/u.test(n)).length, 0);
    const old = randomUUID();
    const path = importRequestPaths(f.root, old).directory;
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, IMPORT_REQUEST_MARKER), importRequestMarker(old), { mode: 0o600 });
    await utimes(join(path, IMPORT_REQUEST_MARKER), new Date(0), new Date(0));
    await cleanupStaleImportMaterials(f.root, now);
    assert.equal((await readdir(f.root)).includes(old), false);
    const foreign = randomUUID();
    await mkdir(join(f.root, foreign), { mode: 0o700 });
    await cleanupStaleImportMaterials(f.root, now);
    assert.ok((await readdir(f.root)).includes(foreign));
    await assert.rejects(cleanupImportRequest(f.root, foreign));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("linked private roots and escaped request ids are rejected", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.directory, "external"), { mode: 0o700 });
    await symlink(join(f.directory, "external"), f.root);
    await assert.rejects(openImportRequestRoot(f.root));
    assert.throws(() => importRequestPaths(f.root, "../outside"), /REQUEST_INVALID/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
