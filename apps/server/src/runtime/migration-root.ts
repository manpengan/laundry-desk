import { isAbsolute, normalize } from "node:path";

const CONTAINER_MIGRATIONS_ROOT = "/opt/laundry/migrations";

export const resolveRuntimeMigrationsRoot = (
  environment: Readonly<Record<string, string | undefined>>,
): string => {
  const configured = environment.LAUNDRY_RUNTIME_MIGRATIONS_DIR;
  if (configured === undefined) return CONTAINER_MIGRATIONS_ROOT;
  if (
    configured.length === 0 ||
    configured.includes("\0") ||
    !isAbsolute(configured) ||
    normalize(configured) !== configured
  ) {
    throw new Error("RUNTIME_MIGRATIONS_ROOT_INVALID");
  }
  return configured;
};
