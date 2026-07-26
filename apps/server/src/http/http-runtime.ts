import { createLocalRuntime, type LocalRuntime } from "../local/create-runtime.js";

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
  if ((env.DATABASE_URL ?? "").trim().length === 0) {
    throw new Error("HTTP runtime requires an explicit laundry_app DATABASE_URL");
  }
  return dependencies.createRuntime(env);
}
