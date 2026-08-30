import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";

import { createPhotoFileStore, PhotoFileError } from "./file-store.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const WEBP = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ", "binary");
const PHOTO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHOTO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const created: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-photo-")));
  created.push(root);
  return root;
}

after(async () => {
  await Promise.all(created.map((root) => rm(root, { recursive: true, force: true })));
});

function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof PhotoFileError && error.code === code;
}

test("installs and reads private JPEG, PNG, and WebP files with integrity metadata", async () => {
  const root = await tempRoot();
  const store = await createPhotoFileStore({ rootPath: join(root, "photos") });

  for (const [bytes, type, extension] of [
    [JPEG, "image/jpeg", "jpg"],
    [PNG, "image/png", "png"],
    [WEBP, "image/webp", "webp"],
  ] as const) {
    const stored = await store.write(bytes, type);
    assert.match(
      stored.storage_key,
      new RegExp(
        `^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extension}$`,
        "u",
      ),
    );
    assert.equal(stored.content_type, type);
    assert.match(stored.content_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(stored.byte_size, bytes.byteLength);
    assert.deepEqual((await store.read(stored)).bytes, bytes);
    if (process.platform === "win32") {
      assert.equal(
        (await inspectPrivateFile(join(store.rootPath, stored.storage_key))).scheme,
        "windows-dacl-v1",
      );
    } else {
      assert.equal(
        ((await lstat(join(store.rootPath, stored.storage_key))).mode & 0o777).toString(8),
        "600",
      );
    }
  }

  if (process.platform === "win32") {
    assert.equal((await inspectPrivateDirectory(store.rootPath)).scheme, "windows-dacl-v1");
  } else {
    assert.equal(((await lstat(store.rootPath)).mode & 0o777).toString(8), "700");
  }
  assert.equal(
    (await readdir(store.rootPath)).some((name) => name.endsWith(".staging")),
    false,
  );
  assert.equal(
    await readFile(join(store.rootPath, ".laundry-photo-store-v1"), "utf8"),
    "laundry-desk-photo-store:v1\n",
  );
  const markerPath = join(store.rootPath, ".laundry-photo-store-v1");
  if (process.platform === "win32") {
    assert.equal((await inspectPrivateFile(markerPath)).scheme, "windows-dacl-v1");
  } else {
    assert.equal(((await lstat(markerPath)).mode & 0o777).toString(8), "600");
  }
});

test("rejects empty, oversized, disguised, and unsupported photo bytes", async () => {
  const root = await tempRoot();
  const store = await createPhotoFileStore({
    rootPath: join(root, "photos"),
    maxPhotoBytes: JPEG.byteLength,
  });

  await assert.rejects(
    () => store.write(Buffer.alloc(0), "image/jpeg"),
    hasCode("PHOTO_SIZE_INVALID"),
  );
  await assert.rejects(
    () => store.write(Buffer.concat([JPEG, Buffer.from([0x00])]), "image/jpeg"),
    hasCode("PHOTO_SIZE_INVALID"),
  );
  await assert.rejects(() => store.write(JPEG, "image/png"), hasCode("PHOTO_TYPE_INVALID"));
  await assert.rejects(
    () => store.write(Buffer.from("<svg/>"), "image/svg+xml"),
    hasCode("PHOTO_TYPE_INVALID"),
  );
  assert.deepEqual(await readdir(store.rootPath), [".laundry-photo-store-v1"]);
});

test("serializes quota decisions so concurrent uploads cannot exceed limits", async () => {
  const root = await tempRoot();
  const ids = [PHOTO_A, randomStageId(), PHOTO_B, randomStageId()];
  const store = await createPhotoFileStore({
    rootPath: join(root, "photos"),
    maxFiles: 1,
    maxTotalBytes: JPEG.byteLength,
    newId: () => ids.shift() ?? randomStageId(),
  });

  const outcomes = await Promise.allSettled([
    store.write(JPEG, "image/jpeg"),
    store.write(JPEG, "image/jpeg"),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.equal(hasCode("PHOTO_QUOTA_EXCEEDED")(rejected.reason), true);
  assert.equal(
    (await readdir(store.rootPath)).filter((name) => !name.startsWith(".laundry-photo-store"))
      .length,
    1,
  );
});

test("replays one upload id only for identical normalized bytes", async () => {
  const root = await tempRoot();
  const store = await createPhotoFileStore({ rootPath: join(root, "photos") });

  const first = await store.write(JPEG, "image/jpeg", PHOTO_A);
  const replay = await store.write(Buffer.from(JPEG), "image/jpeg", PHOTO_A);

  assert.deepEqual(replay, first);
  assert.equal(first.storage_key, `${PHOTO_A}.jpg`);
  assert.equal((await readdir(store.rootPath)).filter((name) => name.endsWith(".jpg")).length, 1);
  await assert.rejects(
    () => store.write(Buffer.concat([JPEG, Buffer.from([0x00])]), "image/jpeg", PHOTO_A),
    hasCode("PHOTO_IDEMPOTENCY_CONFLICT"),
  );
});

test("refuses filesystem root, unowned directories, and symlink ancestors", async () => {
  await assert.rejects(
    () => createPhotoFileStore({ rootPath: "/" }),
    hasCode("PHOTO_ROOT_INVALID"),
  );
  const root = await tempRoot();
  const unowned = join(root, "unowned");
  await mkdir(unowned, { mode: 0o755 });
  await chmod(unowned, 0o755);
  const originalMode = (await lstat(unowned)).mode & 0o777;
  await writeFile(join(unowned, "do-not-touch.txt"), "keep");
  await assert.rejects(
    () => createPhotoFileStore({ rootPath: unowned }),
    hasCode("PHOTO_ROOT_UNOWNED"),
  );
  assert.equal((await lstat(unowned)).mode & 0o777, originalMode);
  assert.equal(await readFile(join(unowned, "do-not-touch.txt"), "utf8"), "keep");

  const realParent = join(root, "real-parent");
  const linkedParent = join(root, "linked-parent");
  await mkdir(realParent);
  await symlink(realParent, linkedParent);
  await assert.rejects(
    () => createPhotoFileStore({ rootPath: join(linkedParent, "photos") }),
    hasCode("PHOTO_ROOT_INVALID"),
  );
});

test("refuses symlink roots, invalid keys, tampering, and symlinked read targets", async () => {
  const root = await tempRoot();
  const real = join(root, "real");
  const linked = join(root, "linked");
  await mkdir(real);
  await symlink(real, linked);
  await assert.rejects(
    () => createPhotoFileStore({ rootPath: linked }),
    hasCode("PHOTO_ROOT_INVALID"),
  );

  const store = await createPhotoFileStore({ rootPath: join(root, "photos") });
  const stored = await store.write(JPEG, "image/jpeg");
  await assert.rejects(
    () => store.read({ ...stored, storage_key: "../../secret.jpg" }),
    hasCode("PHOTO_STORAGE_KEY_INVALID"),
  );

  await writeFile(join(store.rootPath, stored.storage_key), PNG);
  await assert.rejects(() => store.read(stored), hasCode("PHOTO_FILE_UNAVAILABLE"));
  await assert.rejects(
    () => store.remove(stored.storage_key, stored.content_sha256),
    hasCode("PHOTO_FILE_INTEGRITY"),
  );

  const outside = join(root, "outside.jpg");
  await writeFile(outside, JPEG);
  const linkedKey = `${PHOTO_A}.jpg`;
  await symlink(outside, join(store.rootPath, linkedKey));
  await assert.rejects(
    () =>
      store.read({
        storage_key: linkedKey,
        content_type: "image/jpeg",
        content_sha256: stored.content_sha256,
        byte_size: JPEG.byteLength,
      }),
    hasCode("PHOTO_FILE_UNAVAILABLE"),
  );
  assert.deepEqual(await readFile(outside), JPEG);
});

test("removes only old unreferenced owned files while retaining referenced and stray files", async () => {
  const root = await tempRoot();
  const ids = [PHOTO_A, randomStageId(), PHOTO_B, randomStageId()];
  const store = await createPhotoFileStore({
    rootPath: join(root, "photos"),
    orphanGraceMs: 1_000,
    newId: () => ids.shift() ?? randomStageId(),
  });
  const referenced = await store.write(JPEG, "image/jpeg");
  const orphan = await store.write(PNG, "image/png");
  const stray = join(store.rootPath, "notes.txt");
  await writeFile(stray, "keep");
  const old = new Date(0);
  await utimes(join(store.rootPath, referenced.storage_key), old, old);
  await utimes(join(store.rootPath, orphan.storage_key), old, old);

  const result = await store.sweepOrphans(new Set([referenced.storage_key]), 10_000);
  assert.deepEqual(result, {
    removed: 1,
    removed_bytes: PNG.byteLength,
    retained: 1,
    retained_bytes: JPEG.byteLength,
  });
  assert.deepEqual(await readFile(join(store.rootPath, referenced.storage_key)), JPEG);
  assert.equal(await readFile(stray, "utf8"), "keep");
  await assert.rejects(() => lstat(join(store.rootPath, orphan.storage_key)));
});

function randomStageId(): string {
  return "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
}
