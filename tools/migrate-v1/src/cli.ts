import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { z } from "zod";

import { extractV1Snapshot } from "./extract-v1.js";
import {
  assertV2PostgresMigrationLoader,
  loadV2Migration,
  type V2PostgresMigrationLoader,
} from "./load-v2.js";
import { reconcileMigration } from "./reconcile.js";
import { transformV1Snapshot } from "./transform.js";

type CliOptions = Readonly<{
  source: string;
  dryRun: boolean;
  apply: boolean;
  target: string | undefined;
  loader: string | undefined;
  confirmSourceSha256: string | undefined;
}>;

type CliDependencies = Readonly<{
  write: (line: string) => void;
  extract: typeof extractV1Snapshot;
  transform: typeof transformV1Snapshot;
  reconcile: typeof reconcileMigration;
  load: typeof loadV2Migration;
  importLoader: (specifier: string) => Promise<V2PostgresMigrationLoader>;
}>;

const targetUrlSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        context.addIssue({ code: "custom", message: "target must use postgres or postgresql" });
        return z.NEVER;
      }
      return value;
    } catch {
      context.addIssue({ code: "custom", message: "target must be a PostgreSQL URL" });
      return z.NEVER;
    }
  });

const FLAG_OPTIONS = new Set(["--dry-run", "--apply"]);
const VALUE_OPTIONS = new Set(["--source", "--target", "--loader", "--confirm-source-sha256"]);

function parseArguments(args: readonly string[]): ReadonlyMap<string, string | true> {
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined || parsed.has(argument)) throw new Error("invalid option grammar");
    if (FLAG_OPTIONS.has(argument)) {
      parsed.set(argument, true);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) throw new Error("invalid option grammar");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("invalid option grammar");
    parsed.set(argument, value);
    index += 1;
  }
  return parsed;
}

const optionValue = (parsed: ReadonlyMap<string, string | true>, name: string) => {
  const value = parsed.get(name);
  return typeof value === "string" ? value : undefined;
};

export function parseCliOptions(args: readonly string[]): CliOptions {
  const parsed = parseArguments(args);
  const source = optionValue(parsed, "--source");
  if (source === undefined) throw new Error("--source is required");
  const apply = parsed.has("--apply");
  const dryRun = parsed.has("--dry-run") || !apply;
  if (apply && parsed.has("--dry-run")) throw new Error("--apply and --dry-run cannot be combined");
  const options: CliOptions = Object.freeze({
    source,
    apply,
    dryRun,
    target: optionValue(parsed, "--target"),
    loader: optionValue(parsed, "--loader"),
    confirmSourceSha256: optionValue(parsed, "--confirm-source-sha256"),
  });
  if (options.apply) {
    if (options.target === undefined)
      throw new Error("--apply requires an explicit --target PostgreSQL URL");
    targetUrlSchema.parse(options.target);
    if (options.loader === undefined)
      throw new Error("--apply requires --loader for the schema-owned PG port");
    if (options.confirmSourceSha256 === undefined) {
      throw new Error("--apply requires --confirm-source-sha256 from a reviewed dry run");
    }
    if (!/^[0-9a-f]{64}$/u.test(options.confirmSourceSha256)) {
      throw new Error("--confirm-source-sha256 must be one lowercase SHA-256");
    }
  } else if (
    options.target !== undefined ||
    options.loader !== undefined ||
    options.confirmSourceSha256 !== undefined
  ) {
    throw new Error("apply-only options require --apply");
  }
  return options;
}

function defaultDependencies(): CliDependencies {
  return Object.freeze({
    write: (line) => process.stdout.write(`${line}\n`),
    extract: extractV1Snapshot,
    transform: transformV1Snapshot,
    reconcile: reconcileMigration,
    load: loadV2Migration,
    importLoader: importV2PostgresLoader,
  });
}

async function importV2PostgresLoader(specifier: string): Promise<V2PostgresMigrationLoader> {
  const moduleUrl = pathToFileURL(resolve(process.cwd(), specifier)).href;
  const imported: unknown = await import(moduleUrl);
  if (typeof imported !== "object" || imported === null) {
    throw new Error("migration loader module must export default or loader");
  }
  const exports = imported as Record<string, unknown>;
  return assertV2PostgresMigrationLoader(exports.default ?? exports.loader);
}

function reportOutput(
  report: ReturnType<typeof reconcileMigration>,
  mode: "dry-run" | "apply",
): string {
  return JSON.stringify({
    mode,
    sourceBackupSha256: report.sourceBackupSha256,
    source: report.source,
    target: report.target,
    differences: report.differences,
    isZeroDifference: report.isZeroDifference,
  });
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = defaultDependencies(),
): Promise<number> {
  let failureCode = "V1_MIGRATION_OPTIONS_INVALID";
  try {
    const options = parseCliOptions(args);
    failureCode = "V1_MIGRATION_SOURCE_INVALID";
    const snapshot = await dependencies.extract(options.source);
    failureCode = "V1_MIGRATION_TRANSFORM_INVALID";
    const plan = dependencies.transform(snapshot);
    failureCode = "V1_MIGRATION_RECONCILIATION_INVALID";
    const report = dependencies.reconcile(snapshot, plan);
    dependencies.write(reportOutput(report, options.dryRun ? "dry-run" : "apply"));
    if (!report.isZeroDifference) return 1;
    if (options.dryRun) return 0;
    failureCode = "V1_MIGRATION_SOURCE_CONFIRMATION_MISMATCH";
    if (options.confirmSourceSha256 !== snapshot.sourceBackupSha256) {
      throw new Error("--confirm-source-sha256 does not match this exact v1 backup");
    }
    failureCode = "V1_MIGRATION_LOADER_INVALID";
    const loader = await dependencies.importLoader(options.loader as string);
    failureCode = "V1_MIGRATION_APPLY_FAILED";
    await dependencies.load(loader, options.target as string, plan, report);
    dependencies.write(
      JSON.stringify({ applied: true, sourceBackupSha256: snapshot.sourceBackupSha256 }),
    );
    return 0;
  } catch {
    dependencies.write(JSON.stringify({ ok: false, error: failureCode }));
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
