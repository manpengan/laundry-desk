import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { loadLocalConfig } from "./config.mjs";
import { listRecoverySets } from "./maintenance-state.mjs";
import { SUPPORT_BUNDLE_MANIFEST } from "./support-bundle.mjs";
import {
  assertManagedDirectory,
  readManagedFile,
  SUPPORT_BUNDLE_MAXIMUM_BYTES,
} from "./support-bundle-safety.mjs";

const SUPPORT_BUNDLE_NAME = /^laundry-v2-support-\d{8}T\d{6}Z-[0-9a-f]{24}\.json$/u;
export const ACCEPTANCE_ADMIN_ENV_KEYS = Object.freeze([
  "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
  "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
]);
const command = (...args) => Object.freeze({ file: "pnpm", args: Object.freeze(args) });
const MAINTENANCE = command("local:maintenance");
const SUPPORT_BUNDLE = command("local:support-bundle");

export async function loadAcceptanceSecretValues({ env }) {
  const config = await loadLocalConfig({ env });
  return Object.freeze([
    config.postgresSuperuserPassword,
    config.postgresAppPassword,
    config.accessTokenSecret,
    config.csrfProofSecret,
  ]);
}

export async function findAcceptanceRecoverySet({ env }) {
  const config = await loadLocalConfig({ env });
  const backupDirectory = await realpath(join(env.LAUNDRY_LOCAL_CONFIG_DIR, "backups"));
  const recovery = (await listRecoverySets({ backupDirectory, config })).find(
    (set) => set.verified !== null && set.sha256 !== null,
  );
  if (recovery === undefined) return null;
  return Object.freeze({ path: recovery.path, sha256: recovery.sha256 });
}

export async function validateSupportBundles({ configDirectory, secretValues, expectedCount = 2 }) {
  const outputDirectory = await assertManagedDirectory(join(configDirectory, "support-bundles"));
  const names = await readdir(outputDirectory);
  if (names.length !== expectedCount || names.some((name) => !SUPPORT_BUNDLE_NAME.test(name))) {
    throw new Error("ACCEPTANCE_SUPPORT_BUNDLE_COUNT_INVALID");
  }
  for (const name of names) {
    const bytes = await readManagedFile(outputDirectory, name, SUPPORT_BUNDLE_MAXIMUM_BYTES);
    const text = bytes.toString("utf8");
    for (const secret of secretValues) {
      if (typeof secret !== "string" || secret.length === 0 || text.includes(secret)) {
        throw new Error("ACCEPTANCE_SUPPORT_BUNDLE_SECRET_LEAK");
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("ACCEPTANCE_SUPPORT_BUNDLE_INVALID");
    }
    if (
      parsed?.version !== 1 ||
      JSON.stringify(parsed.manifest) !== JSON.stringify(SUPPORT_BUNDLE_MANIFEST) ||
      JSON.stringify(Object.keys(parsed.sections ?? {})) !==
        JSON.stringify(SUPPORT_BUNDLE_MANIFEST.sections)
    ) {
      throw new Error("ACCEPTANCE_SUPPORT_BUNDLE_INVALID");
    }
  }
}

export async function runOnlineRecoveryAcceptance({ execute, dependencies, env }) {
  await execute("ACCEPTANCE_MAINTENANCE_FAILED", MAINTENANCE, env);
  await dependencies.waitForHealth({ expected: "up" });
  const recovery = await dependencies.findRecoverySet({ env });
  if (recovery === null) throw new Error("ACCEPTANCE_RECOVERY_SET_INVALID");
  await execute(
    "ACCEPTANCE_RESTORE_DRILL_FAILED",
    command("local:restore:drill", "--file", recovery.path, "--confirm-sha256", recovery.sha256),
    env,
  );
  await execute("ACCEPTANCE_RUNNING_SUPPORT_BUNDLE_FAILED", SUPPORT_BUNDLE, env);
}

export async function runStoppedSupportAcceptance(context, credentials, dependencies, execute) {
  const env = context.baseEnvironment;
  await execute("ACCEPTANCE_STOPPED_SUPPORT_BUNDLE_FAILED", SUPPORT_BUNDLE, env);
  const localSecrets = await dependencies.loadSecretValues({ env });
  await dependencies.validateSupportBundles({
    configDirectory: context.configDirectory,
    secretValues: Object.freeze([
      credentials.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
      credentials.LAUNDRY_BOOTSTRAP_ADMIN_PIN,
      ...localSecrets,
    ]),
    expectedCount: 2,
  });
}
