import pg from "pg";

const { Pool } = pg;

export function createPool() {
  const connectionString = process.env.LEASE_DATABASE_URL;
  if (!connectionString) throw new Error("LEASE_DATABASE_URL is required");
  return new Pool({ connectionString, max: 10 });
}

export function createAdminPool() {
  const connectionString = process.env.LEASE_ADMIN_DATABASE_URL;
  if (!connectionString)
    throw new Error("LEASE_ADMIN_DATABASE_URL is required");
  return new Pool({ connectionString, max: 2 });
}

export function clockAt(iso) {
  return Object.freeze({
    async now() {
      return new Date(iso);
    },
  });
}

export async function resetStore(pool, ids) {
  await pool.query(
    `TRUNCATE replay_domain_effects, primary_lease_replay_state,
       offline_command_audit, primary_leases, primary_lease_heads`,
  );
  await pool.query(
    `INSERT INTO primary_lease_heads (org_id, store_id)
     VALUES ($1, $2)`,
    [ids.org_id, ids.store_id],
  );
}
