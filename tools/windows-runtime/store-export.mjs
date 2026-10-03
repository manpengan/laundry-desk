import { createRequire } from "node:module";
import { join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { fail } from "./companion-contract.mjs";

/** Maintenance entry owns lock/service stop; input never supplies tenant or a DB URL. */
export async function exportStore(context, { destination, requestId }) {
  if (
    typeof destination !== "string" ||
    !isAbsolute(destination) ||
    typeof requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestId)
  )
    fail("ARGS_INVALID");
  const within = relative(context.root, destination);
  if (within === "" || (!within.startsWith("..") && !isAbsolute(within))) fail("ARGS_INVALID");
  const module = (path) => import(pathToFileURL(join(context.payload, "server/dist", path)).href);
  const [
    { runApprovedStoreExport },
    { LOCAL_PROFILE },
    { createPhotoFileStore },
    { createDeliveryEvidenceFileStore },
    { readSecretValue },
  ] = await Promise.all([
    module("data-transfer/store-export-worker.js"),
    module("local/profile.js"),
    module("photo/file-store.js"),
    module("delivery-evidence/file-store.js"),
    module("local/secret-file.js"),
  ]);
  const require = createRequire(join(context.payload, "server/package.json"));
  const { Pool } = require("pg");
  const url = await context.io.read(context.env.DATABASE_ADMIN_URL_FILE);
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "8543" ||
    parsed.pathname !== "/laundry_v2" ||
    parsed.username !== "postgres" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    fail("DATABASE_BINDING_INVALID");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const photoRoot = join(context.root, "photos");
    return await runApprovedStoreExport({
      maintenancePool: pool,
      signingSecret: readSecretValue(context.env, "LAUNDRY_ACCESS_TOKEN_SECRET"),
      destination,
      requestId,
      // Initial RLS scope only; signature/session validation supplies the export actor.
      configuredTenant: {
        orgId: LOCAL_PROFILE.orgId,
        storeId: LOCAL_PROFILE.storeId,
        staffId: LOCAL_PROFILE.adminStaffId,
      },
      photos: {
        garment: await createPhotoFileStore({ rootPath: photoRoot }),
        delivery: await createDeliveryEvidenceFileStore(photoRoot),
      },
    });
  } finally {
    await pool.end();
  }
}
