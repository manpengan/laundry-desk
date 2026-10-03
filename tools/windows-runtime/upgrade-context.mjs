import { join } from "node:path";
import { digest, fail } from "./companion-contract.mjs";
import { runtimeEnvironment } from "./lifecycle-environment.mjs";
import { serverEnvironment } from "./lifecycle-database.mjs";
import { run } from "./lifecycle-process.mjs";
import { restorePhotoDirectory } from "./backup-photo-files.mjs";
import { withPortableStage } from "./portable-container.mjs";

export async function upgradeContext(lifecycle, entry, dependencies = {}) {
  const { payload, manifest } = await lifecycle.verify(entry);
  const env = await (dependencies.runtimeEnvironment ?? runtimeEnvironment)(
    lifecycle.root,
    payload,
    manifest,
    lifecycle.io,
  );
  return {
    ...lifecycle,
    entry,
    payload,
    manifest,
    env,
    instance: digest(await lifecycle.io.read(join(lifecycle.root, "secrets/access-token-secret"))),
    postgresVersion: manifest.sources.postgres.version,
  };
}
export async function shadowEnvironment(context, name) {
  if (!/^laundry_restore_[a-f0-9]{32}$/u.test(name)) fail("UPGRADE_SHADOW_REQUIRED");
  const folder = join(context.root, "maintenance-secrets");
  await context.io.directory(folder);
  const env = { ...context.env };
  for (const key of ["DATABASE_ADMIN_URL", "DATABASE_URL"]) {
    const url = new URL(await context.io.read(env[`${key}_FILE`]));
    if (url.hostname !== "127.0.0.1" || url.port !== "8543" || url.pathname !== "/laundry_v2")
      fail("DATABASE_BINDING_INVALID");
    url.pathname = `/${name}`;
    const path = join(folder, key.toLowerCase());
    await context.io.write(path, url.href);
    env[`${key}_FILE`] = path;
  }
  return env;
}
export async function probeShadow(context, name, backup) {
  const env = await shadowEnvironment(context, name);
  await withPortableStage(context, async (directory) => {
    const parent = join(directory, "laundry-desk-v2");
    const scratch = join(parent, "runtime-companion");
    await context.io.directory(parent);
    await context.io.directory(scratch);
    await restorePhotoDirectory(
      { ...context, root: scratch },
      join(context.root, "backups", backup.id),
      backup.manifest.photos,
    );
    const selected = {
      ...serverEnvironment(env),
      LOCALAPPDATA: directory,
      LAUNDRY_PHOTO_STORE_DIR: join(scratch, "photos"),
    };
    const result = await run(
      join(context.payload, "node/node.exe"),
      [
        join(context.toolsPayload ?? context.payload, "scripts/upgrade-probe.mjs"),
        context.payload,
        context.entry.digest,
      ],
      selected,
      directory,
    );
    if (!result.includes("WINDOWS_RUNTIME_SHADOW_PROBE_OK")) fail("PROGRAM_PROBE_FAILED");
  });
}
