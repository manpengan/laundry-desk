import { fail } from "./companion-contract.mjs";
import { randomUUID } from "node:crypto";
import { withDataClient } from "./data-worker.mjs";
import { discoverPortableSchema, identifier, requirePortableRow } from "./portable-schema.mjs";
import { resetPortableAuthority } from "./portable-authority.mjs";
import { readRollbackIdentity, overlayRollbackIdentity } from "./rollback-identity.mjs";

const TABLES = new Set([
  "sessions",
  "refresh_families",
  "refresh_tokens",
  "customer_portal_sessions",
  "edge_devices",
  "offline_grants",
  "primary_leases",
  "primary_lease_heads",
  "edge_authority_challenges",
  "pin_challenges",
  "step_up_proofs",
  "staff_credential_setups",
  "ai_pending_actions",
  "ai_approval_requests",
  "v1_import_requests",
  "store_export_requests",
  "notification_deliveries",
  "notification_provider_settings",
  "ai_provider_keys",
  "ai_safety_policies",
  "ai_sessions",
  "ai_turns",
  "automation_policies",
]);

/** Revoke restored execution grants without altering business rows or paid-send receipts. */
export async function revokeRestoredAuthority(
  client,
  shadow,
  identity,
  timestamp = new Date().toISOString(),
) {
  if (typeof shadow !== "string" || !/^laundry_restore_[a-f0-9]{32}$/u.test(shadow))
    fail("RESTORE_SHADOW_REQUIRED");
  const { rows } = await client.query(
    "SELECT current_database() AS name, pg_catalog.shobj_description(oid, 'pg_database') AS marker FROM pg_catalog.pg_database WHERE datname=current_database()",
  );
  if (rows.length !== 1 || rows[0].name !== shadow || rows[0].marker !== shadow)
    fail("RESTORE_SHADOW_REQUIRED");
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await client.query(
      "SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO, YMD'; SET LOCAL statement_timeout='60s'",
    );
    const schema = await discoverPortableSchema(client);
    await overlayRollbackIdentity(client, schema, identity);
    const counts = {};
    for (const table of schema.filter((item) => TABLES.has(item.name))) {
      // SMS settings have no terminal credential state and their envelope is
      // non-nullable. Removing the private configuration forces fresh input;
      // delivery receipts and their reserved/actual costs remain untouched.
      if (table.name === "notification_provider_settings") {
        const result = await client.query("DELETE FROM public.notification_provider_settings");
        counts[table.name] = result.rowCount;
        continue;
      }
      const fields = table.columns.map((column) => `${identifier(column.name)}::text`).join(",");
      await client.query(
        `DECLARE restore_authority_rows NO SCROLL CURSOR FOR SELECT ctid::text AS tid,json_build_array(${fields})::text AS value FROM public.${identifier(table.name)} FOR UPDATE`,
      );
      while (true) {
        const batch = await client.query("FETCH FORWARD 64 FROM restore_authority_rows");
        if (!batch.rows.length) break;
        for (const row of batch.rows) {
          if (typeof row.tid !== "string" || !/^\([0-9]+,[0-9]+\)$/u.test(row.tid))
            fail("RESTORE_AUTHORITY_INVALID");
          const original = requirePortableRow(JSON.parse(row.value), table);
          const next = resetPortableAuthority(table, original, timestamp);
          const changed = table.columns
            .map((column, index) => ({ column, index }))
            .filter(({ index }) => original[index] !== next[index]);
          if (!changed.length) continue;
          const set = changed
            .map(({ column }, index) => `${identifier(column.name)}=$${index + 1}::${column.type}`)
            .join(",");
          const result = await client.query(
            `UPDATE public.${identifier(table.name)} SET ${set} WHERE ctid=$${changed.length + 1}::tid`,
            [...changed.map(({ index }) => next[index]), row.tid],
          );
          if (result.rowCount !== 1) fail("RESTORE_AUTHORITY_CHANGED");
          counts[table.name] = (counts[table.name] ?? 0) + 1;
        }
      }
      await client.query("CLOSE restore_authority_rows");
    }
    const stores = await client.query("SELECT org_id,id FROM public.stores");
    for (const store of stores.rows)
      await client.query(
        "INSERT INTO public.audit_log(id,org_id,store_id,staff_id,via,command,entity,entity_id,after_json,at) VALUES($1,$2,$3,NULL,'ui','runtime.restore.revoke_authority','runtime_maintenance',$4,$5,$6)",
        [
          randomUUID(),
          store.org_id,
          store.id,
          shadow,
          JSON.stringify({ changed_rows: counts, external_outcomes: "requires_reconciliation" }),
          timestamp,
        ],
      );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function resetRollbackAuthority(context, name) {
  const identity = await withDataClient(context, "laundry_v2", readRollbackIdentity);
  return withDataClient(context, name, (client) => revokeRestoredAuthority(client, name, identity));
}
