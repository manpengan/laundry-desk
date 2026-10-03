/** Test-only isolation for production modules whose LOCAL tenant is intentionally fixed. */
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPgPool, type ResolvedPgUrls } from "./pg-pool.js";
import { loadMigrationBundle } from "../runtime/migration-bundle.js";

export async function createIsolatedPgTestDatabase(source: ResolvedPgUrls) {
  const database = `laundry_test_${randomBytes(12).toString("hex")}`;
  const url = (sourceUrl: string, name: string) => {
    const value = new URL(sourceUrl);
    value.pathname = `/${name}`;
    return value.href;
  };
  const control = createPgPool({ connectionString: url(source.admin, "postgres"), max: 1 });
  let created = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      // pg-pool can resolve end() before idle sockets emit end. Normal DROP waits for
      // their graceful disconnect; FORCE can instead emit a fatal idle-client error.
      if (created) await control.query(`DROP DATABASE "${database}"`);
    } finally {
      await control.end();
    }
  };
  try {
    // The surrounding CI fixture owns global roles. Never alter their attributes or passwords.
    const roles = await control.query<{
      count: number;
    }>(`SELECT count(*)::int FROM pg_catalog.pg_roles
      WHERE rolname IN ('laundry_owner','laundry_app','laundry_store_exporter')`);
    if (roles.rows[0]?.count !== 3) throw new Error("ISOLATED_PG_ROLES_UNAVAILABLE");
    await control.query(
      `CREATE DATABASE "${database}" WITH TEMPLATE template0 OWNER laundry_owner`,
    );
    created = true;
    const urls = Object.freeze({
      admin: url(source.admin, database),
      app: url(source.app, database),
    });
    const admin = createPgPool({ connectionString: urls.admin, max: 1 });
    try {
      const bundle = await loadMigrationBundle(
        fileURLToPath(new URL("../../../../packages/db/src/migrations/", import.meta.url)),
      );
      await admin.query(
        "GRANT ALL ON SCHEMA public TO laundry_owner; GRANT USAGE ON SCHEMA public TO laundry_app",
      );
      for (const entry of bundle.entries) {
        // Role setup has already been verified above; all remaining DDL is scoped to this new DB.
        if (entry.filename === "0001_roles.sql") continue;
        await admin.query(`BEGIN; SET LOCAL ROLE laundry_owner;\n${entry.sql}\nCOMMIT;`);
      }
    } finally {
      await admin.end();
    }
    return Object.freeze({ urls, close });
  } catch (error) {
    await close();
    throw error;
  }
}
