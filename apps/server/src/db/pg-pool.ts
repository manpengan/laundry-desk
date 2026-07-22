/**
 * node-pg Pool factory for local / compose Postgres.
 * Identity and seed use this; bus SqlClient adapter can wrap the same pool later.
 */

import pg from "pg";

export type PgPool = pg.Pool;
export type PgPoolClient = pg.PoolClient;

export type CreatePoolOptions = Readonly<{
  connectionString: string;
  max?: number;
}>;

/** Default local compose URLs (LOCAL ONLY — weak credentials). */
export const LOCAL_PG_URLS = Object.freeze({
  app: "postgresql://laundry_app:app_secure_password@127.0.0.1:8543/laundry_v2",
  admin: "postgresql://postgres:postgres_secure_password@127.0.0.1:8543/laundry_v2",
});

/**
 * Prefer explicit DATABASE_URL; otherwise admin URL for identity seed/store
 * (superuser bypasses FORCE RLS so login/refresh hash lookup works without GUC).
 * App-role + GUC path is layered later for bus commands.
 */
export function resolveIdentityDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const admin = env.DATABASE_ADMIN_URL?.trim() ?? env.SUPERUSER_DATABASE_URL?.trim();
  if (admin !== undefined && admin.length > 0) return admin;
  if (env.LAUNDRY_USE_LOCAL_PG === "1" || env.LAUNDRY_USE_LOCAL_PG === "true") {
    return LOCAL_PG_URLS.admin;
  }
  return null;
}

export function createPgPool(options: CreatePoolOptions): PgPool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 8,
  });
}

export async function withClient<T>(
  pool: PgPool,
  fn: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  pool: PgPool,
  fn: (client: PgPoolClient) => Promise<T>,
): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // prefer original error
      }
      throw error;
    }
  });
}
