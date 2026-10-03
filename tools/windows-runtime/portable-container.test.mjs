import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { backupFixture } from "./backup-test-fixture.mjs";
import { digest } from "./companion-contract.mjs";
import {
  exportPortableContainer,
  importPortableContainer,
  privateOutput,
  requirePortableManifest,
  withPortableStage,
} from "./portable-container.mjs";
import { readDataOptions, requireDataOptions } from "./data-options.mjs";

const password = Buffer.from("synthetic-portable-password");
async function material(context, directory) {
  const bytes = Buffer.from("synthetic database\n");
  const photo = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
  const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
  await privateOutput(context, join(directory, "database.ndjson"), (file) => file.writeFile(bytes));
  await context.io.directory(join(directory, "photos"));
  await privateOutput(context, join(directory, "photos", key), (file) => file.writeFile(photo));
  return {
    manifest: {
      version: 1,
      created_at: new Date().toISOString(),
      release: context.entry,
      postgres_version: "16.15",
      database: {
        schema: [
          {
            name: "laundry_schema_migrations",
            columns: [{ name: "filename", type: "text" }],
            parents: [],
            sequences: [],
          },
        ],
        counts: { laundry_schema_migrations: 1 },
        sequences: {},
        size: bytes.length,
        sha256: digest(bytes),
      },
      photos: [{ key, size: photo.length, sha256: digest(photo) }],
    },
    bytes,
    photo,
    key,
  };
}

test("encrypted container restores only private known database/photos with all hashes verified", async (t) => {
  const context = await backupFixture(t),
    destination = join(context.root, "copy.ldbackup");
  let fixture, exported;
  await withPortableStage(context, async (directory) => {
    fixture = await material(context, directory);
    exported = await exportPortableContainer(
      context,
      directory,
      fixture.manifest,
      destination,
      password,
    );
  });
  assert.equal((await readFile(destination)).includes(fixture.bytes), false);
  await withPortableStage(context, async (directory) => {
    const imported = await importPortableContainer(
      context,
      directory,
      destination,
      password,
      exported.sha256,
    );
    assert.deepEqual(imported.manifest, fixture.manifest);
    assert.deepEqual(await readFile(join(directory, "database.ndjson")), fixture.bytes);
    assert.deepEqual(await readFile(join(directory, "photos", fixture.key)), fixture.photo);
    await context.platform.inspectPrivateFile(join(directory, "database.ndjson"));
    await context.platform.inspectPrivateFile(join(directory, "photos", fixture.key));
  });
  await withPortableStage(context, (directory) =>
    assert.rejects(
      importPortableContainer(context, directory, destination, password, "0".repeat(64)),
      /CONFIRMATION_MISMATCH/,
    ),
  );
});

test("container rejects replacement, unsafe names and existing output without overwriting", async (t) => {
  const context = await backupFixture(t),
    destination = join(context.root, "existing.ldbackup");
  await writeFile(destination, "existing");
  await withPortableStage(context, async (directory) => {
    const { manifest } = await material(context, directory);
    await assert.rejects(
      exportPortableContainer(context, directory, manifest, destination, password),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(destination, "utf8"), "existing");
    assert.throws(
      () =>
        requirePortableManifest({
          ...manifest,
          photos: [{ ...manifest.photos[0], key: "../escape.png" }],
        }),
      /PHOTO_ENTRY/,
    );
  });
  const linked = join(context.root, "link.ldbackup");
  await symlink(destination, linked);
  await withPortableStage(context, (directory) =>
    assert.rejects(importPortableContainer(context, directory, linked, password), /FILE_INVALID/),
  );
});

test("secret input is bounded, exact and never accepts tenant arguments", async () => {
  const data = Buffer.from(
    JSON.stringify({ path: "C:\\copy.ldbackup", password: "synthetic-password" }),
  );
  const result = await readDataOptions("portable-export", Readable.from([data]));
  assert.equal(result.password.toString(), "synthetic-password");
  assert.ok(data.every((byte) => byte === 0));
  result.password.fill(0);
  const bad = [
    { requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", orgId: "foreign" },
    { requestId: "../escape" },
  ];
  for (const value of bad)
    assert.throws(() => requireDataOptions("v1-import", value), /ARGS_INVALID/);
  await assert.rejects(
    readDataOptions("portable-export", Readable.from([Buffer.alloc(8193)])),
    /ARGS_INVALID/,
  );
  await assert.rejects(
    readDataOptions("portable-export", Readable.from([Buffer.from([0xff])])),
    /ARGS_INVALID/,
  );
});
