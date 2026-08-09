import type { PgPoolClient } from "../db/pg-pool.js";
import { executeCommissionTransaction } from "./bootstrap-commission.js";
import { assertLocalBootstrapReadyCore } from "./bootstrap-readiness.js";
import {
  BootstrapInputSchema,
  BootstrapError,
  CommissionInputSchema,
  computeParsedProfileHash,
  hashCredentialPair,
  type BootstrapDependencies,
  type BootstrapInput,
  type BootstrapResult,
  type CommissionInput,
  type CommissionResult,
} from "./bootstrap-model.js";
import { executeBootstrapTransaction } from "./bootstrap-store.js";
import { LOCAL_PROFILE } from "./profile.js";

export * from "./bootstrap-constants.js";
export {
  BootstrapError,
  BootstrapInputSchema,
  CommissionInputSchema,
  computeBootstrapProfileHash,
  type BootstrapDependencies,
  type BootstrapErrorCode,
  type BootstrapInput,
  type BootstrapResult,
  type CommissionInput,
  type CommissionResult,
} from "./bootstrap-model.js";
export { LocalRuntimeReadinessError } from "./bootstrap-readiness.js";

export type LocalRuntimeCommissioningState = "commissioned" | "commission_required";

const rollbackOrThrow = async (
  client: PgPoolClient,
  cause: unknown,
  rollbackCode: "BOOTSTRAP_ROLLBACK_FAILED" | "COMMISSION_ROLLBACK_FAILED",
): Promise<never> => {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new BootstrapError(rollbackCode, { cause: Object.freeze({ cause, rollbackError }) });
  }
  throw cause;
};

export async function assertLocalBootstrapReady(
  pool: BootstrapDependencies["pool"],
  expectedDemoOnly = false,
): Promise<void> {
  await localRuntimeCommissioningState(pool, expectedDemoOnly);
}

export async function assertLocalCommissionedReady(
  pool: BootstrapDependencies["pool"],
  expectedDemoOnly = false,
): Promise<void> {
  await localRuntimeCommissioningState(pool, expectedDemoOnly, true);
}

export async function localRuntimeCommissioningState(
  pool: BootstrapDependencies["pool"],
  expectedDemoOnly = false,
  requireCommissioned = false,
): Promise<LocalRuntimeCommissioningState> {
  return await assertLocalBootstrapReadyCore(
    pool,
    expectedDemoOnly,
    (adminUsername, adminDisplayName) =>
      computeParsedProfileHash({
        profile: LOCAL_PROFILE,
        adminUsername,
        adminDisplayName,
        demoOnly: expectedDemoOnly,
      }),
    requireCommissioned,
  );
}

export async function bootstrapLocalIdentity(
  dependencies: BootstrapDependencies,
  rawInput: BootstrapInput,
): Promise<BootstrapResult> {
  const input = BootstrapInputSchema.parse(rawInput);
  const [admin, approver] = await Promise.all([
    hashCredentialPair(
      dependencies.passwordPort,
      input.adminPassword,
      input.adminPin,
      "BOOTSTRAP_HASH_FAILED",
    ),
    hashCredentialPair(
      dependencies.passwordPort,
      input.approverPassword,
      input.approverPin,
      "BOOTSTRAP_HASH_FAILED",
    ),
  ]);
  const profileHash = computeParsedProfileHash(input);
  const now = (dependencies.now ?? (() => new Date()))();
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await executeBootstrapTransaction(
        client,
        dependencies.passwordPort,
        input,
        Object.freeze({ admin, approver }),
        profileHash,
        now,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      return await rollbackOrThrow(client, error, "BOOTSTRAP_ROLLBACK_FAILED");
    }
  } finally {
    client.release();
  }
}

export async function commissionLocalIdentity(
  dependencies: BootstrapDependencies,
  rawInput: CommissionInput,
): Promise<CommissionResult> {
  const input = CommissionInputSchema.parse(rawInput);
  const credentials = await hashCredentialPair(
    dependencies.passwordPort,
    input.approverPassword,
    input.approverPin,
    "COMMISSION_HASH_FAILED",
  );
  const now = (dependencies.now ?? (() => new Date()))();
  const client = await dependencies.pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await executeCommissionTransaction(
        client,
        dependencies.passwordPort,
        input,
        credentials,
        now,
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      return await rollbackOrThrow(client, error, "COMMISSION_ROLLBACK_FAILED");
    }
  } finally {
    client.release();
  }
}
