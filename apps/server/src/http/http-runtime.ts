import { createLocalRuntime, type LocalRuntime } from "../local/create-runtime.js";
import { resolveRuntimeDatabaseUrl } from "../db/pg-pool.js";

export type HttpRuntimeDependencies = Readonly<{
  createRuntime: (env: NodeJS.ProcessEnv) => Promise<LocalRuntime>;
}>;

const DEFAULT_DEPENDENCIES: HttpRuntimeDependencies = Object.freeze({
  createRuntime: createLocalRuntime,
});

/**
 * A process that opens a listening socket must always use the durable app-role database.
 * The memory runtime remains available only through direct test injection into createLocalApp.
 */
export async function createHttpRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: HttpRuntimeDependencies = DEFAULT_DEPENDENCIES,
): Promise<LocalRuntime> {
  const databaseUrl = resolveRuntimeDatabaseUrl({
    DATABASE_URL: env.DATABASE_URL,
    DATABASE_URL_FILE: env.DATABASE_URL_FILE,
  });
  if (databaseUrl === null) {
    throw new Error("HTTP runtime requires an explicit laundry_app DATABASE_URL");
  }
  return dependencies.createRuntime(env);
}
