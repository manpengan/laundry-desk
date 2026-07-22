/**
 * node-pg Pool factory for local / compose Postgres.
 * Seed uses admin URL; runtime identity uses laundry_app + GUC / definer.
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

export type ResolvedPgUrls = Readonly<{
  /** laundry_app (or explicit DATABASE_URL) for runtime identity. */
  app: string;
  /** Superuser URL for seed bootstrap only. */
  admin: string;
}>;

/**
 * Resolve app + admin URLs when PG mode is requested.
 * - LAUNDRY_USE_LOCAL_PG=1 → compose defaults (app + admin)
 * - DATABASE_URL → runtime app; admin from DATABASE_ADMIN_URL or same URL
 */
export function resolvePgUrls(env: NodeJS.ProcessEnv = process.env): ResolvedPgUrls | null {
  const flag = env.LAUNDRY_USE_LOCAL_PG === "1" || env.LAUNDRY_USE_LOCAL_PG === "true";
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const adminUrl = env.DATABASE_ADMIN_URL?.trim() || env.SUPERUSER_DATABASE_URL?.trim() || "";

  if (!flag && databaseUrl.length === 0 && adminUrl.length === 0) {
    return null;
  }

  if (flag) {
    return Object.freeze({
      app: env.LAUNDRY_PG_APP_URL?.trim() || databaseUrl || LOCAL_PG_URLS.app,
      admin: adminUrl || LOCAL_PG_URLS.admin,
    });
  }

  const app = databaseUrl || adminUrl;
  const admin = adminUrl || databaseUrl || LOCAL_PG_URLS.admin;
  return Object.freeze({ app, admin });
}

/** App-role URL when PG mode is on (tests / legacy call sites). */
export function resolveIdentityDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolvePgUrls(env)?.app ?? null;
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
