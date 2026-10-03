import type { RuntimeRoleClient } from "./role-bootstrap.js";

/** Administrative bootstrap only; never called by the application server. */
export async function ensureStoreExportReaderRole(client: RuntimeRoleClient): Promise<void> {
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='laundry_store_exporter') THEN
      CREATE ROLE laundry_store_exporter NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='laundry_store_exporter'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    THEN RAISE EXCEPTION 'RUNTIME_EXPORT_ROLE_INVALID'; END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='laundry_app') THEN
      IF pg_has_role('laundry_app','laundry_store_exporter','MEMBER')
      THEN RAISE EXCEPTION 'RUNTIME_EXPORT_ROLE_INVALID'; END IF;
    END IF;
  END $$`);
}
