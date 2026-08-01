import { z } from "zod";

const ChecksumSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const MigrationSchema = z.string().regex(/^[0-9]{4}_[a-z0-9_]+\.sql$/u);
const SemverSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u);

const RuntimeReleaseSchema = z.object({
  LAUNDRY_RUNTIME_RELEASE: SemverSchema,
  LAUNDRY_RUNTIME_CONTRACTS_SHA256: ChecksumSchema,
  LAUNDRY_RUNTIME_SCHEMA_SHA256: ChecksumSchema,
  LAUNDRY_RUNTIME_MIGRATIONS_SHA256: ChecksumSchema,
  LAUNDRY_RUNTIME_MIGRATION_HEAD: MigrationSchema,
});

export type RuntimeRelease = Readonly<{
  release: string;
  contractsChecksum: string;
  schemaChecksum: string;
  migrationsChecksum: string;
  migrationHead: string;
}>;

export const parseRuntimeRelease = (
  environment: Readonly<Record<string, string | undefined>>,
): RuntimeRelease => {
  const parsed = RuntimeReleaseSchema.safeParse(environment);
  if (!parsed.success) throw new Error("RUNTIME_RELEASE_INVALID");
  return Object.freeze({
    release: parsed.data.LAUNDRY_RUNTIME_RELEASE,
    contractsChecksum: parsed.data.LAUNDRY_RUNTIME_CONTRACTS_SHA256,
    schemaChecksum: parsed.data.LAUNDRY_RUNTIME_SCHEMA_SHA256,
    migrationsChecksum: parsed.data.LAUNDRY_RUNTIME_MIGRATIONS_SHA256,
    migrationHead: parsed.data.LAUNDRY_RUNTIME_MIGRATION_HEAD,
  });
};
