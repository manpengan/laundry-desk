import { assertLocalBootstrapReady } from "./bootstrap.js";
import { createPgPool, type CreatePoolOptions, type PgPool } from "../db/pg-pool.js";
import { loadPgStaffDirectory } from "./staff-directory.js";

export type CreatePgLocalRuntimeDependencies = Readonly<{
  createPool: (options: CreatePoolOptions) => PgPool;
  assertReady: (pool: PgPool, expectedDemoOnly: boolean) => Promise<void>;
  loadStaffDirectory: typeof loadPgStaffDirectory;
}>;

export const defaultPgRuntimeDependencies: CreatePgLocalRuntimeDependencies = Object.freeze({
  createPool: createPgPool,
  assertReady: assertLocalBootstrapReady,
  loadStaffDirectory: loadPgStaffDirectory,
});

export async function closeFailedPgPool(
  pool: PgPool,
  initializationError: unknown,
): Promise<never> {
  try {
    await pool.end();
  } catch (cleanupError) {
    throw new AggregateError(
      [initializationError, cleanupError],
      "PostgreSQL runtime initialization and pool cleanup both failed",
      { cause: initializationError },
    );
  }
  throw initializationError;
}
