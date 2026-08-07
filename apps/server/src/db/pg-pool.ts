/**
 * node-pg Pool factory for local / compose Postgres.
 * Tests may use both URLs; runtime identity accepts only laundry_app + GUC / definer.
 */

import pg from "pg";

import { readSecretValue } from "../local/secret-file.js";

export type PgPool = pg.Pool;
export type PgPoolClient = pg.PoolClient;

export const RUNTIME_DATABASE_URL_REQUIRED =
  "Runtime requires an explicit database URL for the laundry_app role";

export type CreatePoolOptions = Readonly<{
  connectionString: string;
  max?: number;
  connectionTimeoutMillis?: number;
}>;

export type ResolvedPgUrls = Readonly<{
  /** laundry_app (or explicit DATABASE_URL) for opt-in PG tests. */
  app: string;
  /** Superuser URL for migrations and test fixtures. */
  admin: string;
}>;

/**
 * Resolve app + admin URLs for explicit real-PG integration tests.
 * Runtime code must use resolveRuntimeDatabaseUrl instead.
 * Both role-specific URLs must be explicit. Local integration credentials are generated
 * outside the repository, so this helper never supplies a source default or role fallback.
 */
export function resolvePgUrls(env: NodeJS.ProcessEnv = process.env): ResolvedPgUrls | null {
  const flag = env.LAUNDRY_USE_LOCAL_PG === "1" || env.LAUNDRY_USE_LOCAL_PG === "true";
  const appUrl = env.LAUNDRY_PG_APP_URL?.trim() || env.DATABASE_URL?.trim() || "";
  const adminUrl = env.DATABASE_ADMIN_URL?.trim() || env.SUPERUSER_DATABASE_URL?.trim() || "";

  if (!flag && appUrl.length === 0 && adminUrl.length === 0) {
    return null;
  }
  if (appUrl.length === 0 || adminUrl.length === 0) {
    throw new Error("PG integration requires explicit app and admin database URLs");
  }
  if (appUrl === adminUrl) {
    throw new Error("PG integration must use distinct app and admin database URLs");
  }
  return Object.freeze({ app: appUrl, admin: adminUrl });
}

/**
 * Resolve the runtime app-role URL without ever consulting an owner/admin variable.
 * The local PG opt-in may use its dedicated app URL, but never a source credential default.
 */
export function resolveRuntimeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const databaseUrl = readSecretValue(env, "DATABASE_URL")?.trim() ?? "";
  if (databaseUrl.length > 0) {
    return databaseUrl;
  }
  const localPg = env.LAUNDRY_USE_LOCAL_PG === "1" || env.LAUNDRY_USE_LOCAL_PG === "true";
  if (!localPg) {
    return null;
  }
  const localAppUrl = env.LAUNDRY_PG_APP_URL?.trim() || "";
  if (localAppUrl.length === 0) {
    throw new Error(RUNTIME_DATABASE_URL_REQUIRED);
  }
  return localAppUrl;
}

/** Backward-compatible name for the fail-closed runtime resolver. */
export function resolveIdentityDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveRuntimeDatabaseUrl(env);
}

export function createPgPool(options: CreatePoolOptions): PgPool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 8,
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
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
