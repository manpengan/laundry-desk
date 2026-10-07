import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BACKUP_FILES, PHOTO_BACKUP_FILES } from "./companion-contract.mjs";
import { photoEnvironment, runtimeEnvironment, secretNames } from "./lifecycle-environment.mjs";
import { probeShadow } from "./upgrade-context.mjs";
import { probeApplication } from "./upgrade-probe.mjs";
import { backupFixture } from "./backup-test-fixture.mjs";
import { createBackup } from "./backup-files.mjs";
import { PHOTO_MARKER, PHOTO_MARKER_CONTENT } from "./backup-photo-contract.mjs";

const photoKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
const photoBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const shadow = `laundry_restore_${"a".repeat(32)}`;
const manifest = (photos) => ({
  runtime_release: "0.1.0-win-dev",
  source_git_sha: "b".repeat(40),
  migrations_sha256: "c".repeat(64),
  migration_head: "0069_bounded_automation.sql",
  files: [...BACKUP_FILES, ...(photos ? PHOTO_BACKUP_FILES : [])].map((path) => ({ path })),
});

// Published pre-photo Windows servers accepted only this Linux opt-in path;
// an absent setting disabled file routes without touching any photo directory.
function legacyPhotoPath(env) {
  const raw = env.LAUNDRY_PHOTO_STORE_DIR?.trim();
  if (raw === undefined || raw.length === 0) return null;
  if (raw !== "/var/lib/laundry/photos") throw new Error("LEGACY_PHOTO_PATH_REJECTED");
  return raw;
}

test("startup environments follow the target payload's photo capability, not the controller", async (t) => {
  const base = await backupFixture(t);
  const payload = join(base.root, "payload");
  await base.io.directory(payload);
  await base.io.directory(join(payload, "metadata"));
  await base.io.write(join(payload, "metadata/contracts.json"), "{}");
  await base.io.write(join(payload, "metadata/schema.md"), "synthetic-schema");
  for (const file of [...Object.values(secretNames), "pgpass.conf"])
    await base.io.write(join(base.root, "secrets", file), "synthetic-private-value");
  const previousSystemRoot = process.env.SystemRoot;
  process.env.SystemRoot = previousSystemRoot ?? "C:\\Windows";
  t.after(() => {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
  });
  for (const photos of [false, true]) {
    const selected = await runtimeEnvironment(base.root, payload, manifest(photos), base.io);
    assert.equal(Object.hasOwn(selected, "LAUNDRY_PHOTO_STORE_DIR"), photos);
    if (photos) assert.equal(selected.LAUNDRY_PHOTO_STORE_DIR, join(base.root, "photos"));
    else assert.equal(legacyPhotoPath(selected), null);
    assert.equal(selected.LAUNDRY_RUNTIME_SOURCE_GIT_SHA, "b".repeat(40));
    assert.equal(selected.DATABASE_URL_FILE, join(base.root, "secrets/database-url"));
    assert.equal(selected.DATABASE_URL, undefined);
  }
  assert.equal((await readdir(base.root)).includes("photos"), false);
});

test("photo selection strips stale or arbitrary paths without mutating the caller", () => {
  for (const path of ["/var/lib/laundry/photos", "C:\\unrelated\\photos"]) {
    const env = Object.freeze({ LAUNDRY_PHOTO_STORE_DIR: path, LOCALAPPDATA: "local" });
    assert.deepEqual(photoEnvironment(env, "managed", manifest(false)), { LOCALAPPDATA: "local" });
    assert.deepEqual(photoEnvironment(env, "managed", manifest(true)), {
      LOCALAPPDATA: "local",
      LAUNDRY_PHOTO_STORE_DIR: join("managed", "photos"),
    });
    assert.equal(env.LAUNDRY_PHOTO_STORE_DIR, path);
  }
});

async function shadowFixture(t, photos) {
  const base = await backupFixture(t);
  const live = join(base.root, "photos");
  await base.io.directory(live);
  await base.io.write(join(live, PHOTO_MARKER), PHOTO_MARKER_CONTENT);
  await base.io.write(join(live, photoKey), photoBytes);
  const backup = await createBackup(base, (file) => file.writeFile("synthetic-dump"));
  const env = { LAUNDRY_PHOTO_STORE_DIR: live, PGPASSFILE: "excluded" };
  for (const key of ["DATABASE_ADMIN_URL", "DATABASE_URL"]) {
    const path = join(base.root, "secrets", key);
    await base.io.write(path, "postgresql://synthetic@127.0.0.1:8543/laundry_v2");
    env[`${key}_FILE`] = path;
  }
  return {
    ...base,
    env: Object.freeze(env),
    manifest: manifest(photos),
    payload: join(base.root, photos ? "current-payload" : "legacy-payload"),
    toolsPayload: join(base.root, "current-controller"),
    backup,
    live,
  };
}

for (const photos of [false, true]) {
  test(`shadow probe runs the ${photos ? "photo-capable" : "legacy"} target with isolated photo settings`, async (t) => {
    const context = await shadowFixture(t, photos);
    const originalEnvironment = { ...context.env };
    const events = [];
    let scratch;
    await probeShadow(context, shadow, context.backup, {
      run: async (file, args, env, cwd) => {
        events.push("run");
        assert.equal(file, join(context.payload, "node/node.exe"));
        assert.deepEqual(args, [
          join(context.toolsPayload, "scripts/upgrade-probe.mjs"),
          context.payload,
          context.entry.digest,
        ]);
        assert.equal(env.LOCALAPPDATA, cwd);
        scratch = join(cwd, "laundry-desk-v2/runtime-companion/photos");
        assert.notEqual(scratch, context.live);
        assert.deepEqual(await readFile(join(scratch, photoKey)), photoBytes);
        assert.equal(env.DATABASE_ADMIN_URL_FILE, undefined);
        assert.equal(env.PGPASSFILE, undefined);
        assert.equal(new URL(await readFile(env.DATABASE_URL_FILE, "utf8")).pathname, `/${shadow}`);
        await probeApplication(
          {
            createRuntime: async (selected) => {
              events.push("runtime");
              if (photos) assert.equal(selected.LAUNDRY_PHOTO_STORE_DIR, scratch);
              else {
                assert.equal(Object.hasOwn(selected, "LAUNDRY_PHOTO_STORE_DIR"), false);
                assert.equal(legacyPhotoPath(selected), null);
              }
              return { pool: { end: async () => events.push("pool-close") } };
            },
            parseConfig: () => ({}),
            cookiePolicy: () => ({}),
            aiOptions: async () => ({}),
            createApp: async () => ({
              ready: async () => events.push("ready"),
              inject: async () => {
                events.push("health");
                return { statusCode: 200, json: () => ({ data: { status: "ready" } }) };
              },
              close: async () => events.push("app-close"),
            }),
          },
          env,
        );
        return "WINDOWS_RUNTIME_SHADOW_PROBE_OK";
      },
    });
    assert.deepEqual(events, ["run", "runtime", "ready", "health", "app-close", "pool-close"]);
    assert.deepEqual(context.env, originalEnvironment);
    assert.deepEqual(await readFile(join(context.live, photoKey)), photoBytes);
    assert.deepEqual(
      await readFile(join(context.root, "backups", context.backup.id, "photos", photoKey)),
      photoBytes,
    );
    await assert.rejects(readFile(join(scratch, photoKey)), { code: "ENOENT" });
  });

  test(`${photos ? "photo-capable" : "legacy"} probe still rejects changed backup photo bytes before executing`, async (t) => {
    const context = await shadowFixture(t, photos);
    await writeFile(
      join(context.root, "backups", context.backup.id, "photos", photoKey),
      Buffer.alloc(photoBytes.length),
    );
    await assert.rejects(
      probeShadow(context, shadow, context.backup, { run: async () => assert.fail("probe ran") }),
      /BACKUP_DUMP_MISMATCH/u,
    );
    assert.deepEqual(await readFile(join(context.live, photoKey)), photoBytes);
    assert.equal(
      (await readdir(context.root)).some((name) => name.startsWith("portable-")),
      false,
    );
  });
}

test("legacy probe failures remain failures and the scratch directory is removed", async (t) => {
  const context = await shadowFixture(t, false);
  await assert.rejects(
    probeShadow(context, shadow, context.backup, { run: async () => "not-ready" }),
    /PROGRAM_PROBE_FAILED/u,
  );
  assert.deepEqual(await readFile(join(context.live, photoKey)), photoBytes);
  assert.equal(
    (await readdir(context.root)).some((name) => name.startsWith("portable-")),
    false,
  );
});
