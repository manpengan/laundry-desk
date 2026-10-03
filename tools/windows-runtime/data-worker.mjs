import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fail } from "./companion-contract.mjs";
import { kit } from "./lifecycle-database.mjs";

export async function withDataClient(context, database, action, application = false) {
  if (!/^(?:laundry_v2|laundry_restore_[a-f0-9]{32})$/u.test(database))
    fail("PORTABLE_SHADOW_REQUIRED");
  const require = createRequire(join(context.payload, "server/package.json"));
  const { Client } = require("pg");
  const url = new URL(
    await context.io.read(
      context.env[application ? "DATABASE_URL_FILE" : "DATABASE_ADMIN_URL_FILE"],
    ),
  );
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "8543" ||
    url.pathname !== "/laundry_v2" ||
    url.username !== (application ? "laundry_app" : "postgres")
  )
    fail("DATABASE_BINDING_INVALID");
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.href });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}

export async function migratePortableShadow(context, name) {
  if (!/^laundry_restore_[a-f0-9]{32}$/u.test(name)) fail("PORTABLE_SHADOW_REQUIRED");
  const directory = join(context.root, "maintenance-secrets");
  await context.io.directory(directory);
  const env = { ...context.env };
  for (const key of ["DATABASE_URL", "DATABASE_ADMIN_URL"]) {
    const url = new URL(await context.io.read(env[`${key}_FILE`]));
    url.pathname = `/${name}`;
    const path = join(directory, key.toLowerCase());
    await context.io.write(path, url.href);
    env[`${key}_FILE`] = path;
  }
  await kit(context.payload, "migrate", env, context.root);
}

export async function runApprovedImport(context, requestId, createBackupPoint) {
  const module = (path) => import(pathToFileURL(join(context.payload, "server/dist", path)).href);
  const [{ runApprovedV1Import }, { LOCAL_PROFILE }, { createPhotoFileStore }] = await Promise.all([
    module("data-transfer/import-worker.js"),
    module("local/profile.js"),
    module("photo/file-store.js"),
  ]);
  const require = createRequire(join(context.payload, "server/package.json"));
  const { Pool } = require("pg");
  const url = await context.io.read(context.env.DATABASE_URL_FILE);
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "8543" ||
    parsed.pathname !== "/laundry_v2" ||
    parsed.username !== "laundry_app"
  )
    fail("DATABASE_BINDING_INVALID");
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    return await runApprovedV1Import({
      pool,
      targetDatabaseUrl: url,
      requestRoot: join(context.root, "import-requests"),
      requestId,
      // Initial RLS scope only; the approved ticket supplies the live actor below.
      configuredTenant: {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
        staffId: LOCAL_PROFILE.adminStaffId,
      },
      withMaintenanceLease: (operation) => operation(),
      createBackupPoint,
      photoFiles: await createPhotoFileStore({ rootPath: join(context.root, "photos") }),
    });
  } finally {
    await pool.end();
  }
}
