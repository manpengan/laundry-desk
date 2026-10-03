import { join } from "node:path";
import { z } from "zod";
import type { PgPool } from "../db/pg-pool.js";
import type { TenantContext } from "../db/types.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import { consumeStoreExport, readStoreExportActor } from "./store-export-requests.js";
import { verifyExportSchema } from "./store-export-policy.js";
import { createExportDirectory, exportPrivateFile } from "./store-export-files.js";
import { writeStoreSnapshot, type ExportPhotoReaders } from "./store-export-snapshot.js";
import { verifyStoreExport } from "./store-export-verify.js";

/** Runtime maintenance owns the operation lock and stops concurrent local writers. */
export async function runApprovedStoreExport(
  options: Readonly<{
    maintenancePool: PgPool;
    signingSecret: string;
    configuredTenant: TenantContext;
    requestId: string;
    destination: string;
    photos: ExportPhotoReaders;
  }>,
) {
  z.uuid().parse(options.requestId);
  const directory = await createExportDirectory(options.destination);
  try {
    const result = await withPoolClient(options.maintenancePool, (client) =>
      withTenantTransaction(
        client,
        options.configuredTenant,
        async () => {
          // This pool exists only in the offline maintenance worker. The web
          // process never receives its credential or membership in the reader role.
          await client.query("SET LOCAL ROLE laundry_app");
          const staffId = await readStoreExportActor(
            client,
            options.requestId,
            options.signingSecret,
          );
          const tenant = { ...options.configuredTenant, staffId };
          await client.query("SELECT set_config('app.staff_id',$1,true)", [staffId]);
          await verifyExportSchema(client);
          await client.query("SET LOCAL ROLE laundry_store_exporter");
          const manifest = await writeStoreSnapshot(
            client,
            tenant,
            options.requestId,
            directory.staging,
            options.photos,
          );
          const file = await exportPrivateFile(
            join(directory.staging, "manifest.json"),
            JSON.stringify(manifest, null, 2),
          );
          await verifyStoreExport(directory.staging, file.sha256);
          await client.query("SET LOCAL ROLE laundry_app");
          await consumeStoreExport(client, tenant, options.requestId, file.sha256);
          return {
            manifest_sha256: file.sha256,
            tables: manifest.tables.length,
            rows: manifest.tables.reduce((sum, table) => sum + table.rows, 0),
            photos: manifest.photos.length,
          };
        },
        { isolation: "repeatable_read" },
      ),
    );
    await directory.publish();
    return { ...result, destination: options.destination, assurance: "development_only" as const };
  } catch (error) {
    try {
      await directory.cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "STORE_EXPORT_FAILED_WITH_PRIVATE_STAGING");
    }
    throw error;
  }
}
