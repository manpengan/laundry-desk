import { join } from "node:path";
import { reference } from "./lifecycle-storage.mjs";
import { stageRelease } from "./lifecycle-release.mjs";
import { initializeSecrets, initializeDatabase } from "./lifecycle-database.mjs";
import { withStoreInput } from "./store-initialization.mjs";

export async function installFreshRuntime(context, storeInput, dependencies = {}) {
  const { root, source, expectedDigest, platform, io, save, task, start } = context;
  const stage = dependencies.stageRelease ?? stageRelease;
  const secrets = dependencies.initializeSecrets ?? initializeSecrets;
  const database = dependencies.initializeDatabase ?? initializeDatabase;
  await io.directory(join(root, "releases"));
  await io.directory(join(root, "logs"));
  const staged = await stage(root, source, expectedDigest, platform);
  const entry = reference(staged.manifest, expectedDigest);
  const schema = storeInput === null ? 1 : 2;
  await save({
    schema,
    assurance: "development_only",
    phase: "staged",
    current: entry,
    previous: null,
    controller: entry,
    pending: null,
    releases: [entry],
  });
  await secrets(root, io, { syntheticIdentities: storeInput === null });
  if (storeInput === null) await database(root, staged.payload, staged.manifest, io, platform);
  else
    await withStoreInput(root, storeInput, io, platform, (bootstrapDirectory) =>
      database(root, staged.payload, staged.manifest, io, platform, {
        bootstrapDirectory,
        requireCommissioned: true,
      }),
    );
  // Both strict commissioning and destruction of setup credentials precede startup.
  await save({
    schema,
    assurance: "development_only",
    phase: "initialized",
    current: entry,
    previous: null,
    controller: entry,
    pending: null,
    releases: [entry],
  });
  await task("register", staged.payload, entry);
  await save({
    schema,
    assurance: "development_only",
    phase: "stopped",
    current: entry,
    previous: null,
    controller: entry,
    pending: null,
    releases: [entry],
  });
  await start(entry);
}
