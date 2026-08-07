/** Atomic PIN-success side effects shared by the memory and PG repositories. */

import type { PgPoolClient } from "../db/pg-pool.js";
import type {
  PinChallengeRecord,
  PinLockoutRecord,
  PinSuccessCommit,
  PinSuccessMutation,
} from "./types.js";

const lockoutKey = (input: PinSuccessMutation): string =>
  `${input.org_id}|${input.store_id}|${input.staff_id}|${input.device_id}`;

export async function commitMemoryPinSuccess(
  challenges: Map<string, PinChallengeRecord>,
  lockouts: Map<string, PinLockoutRecord>,
  input: PinSuccessMutation,
  commit: PinSuccessCommit | undefined,
): Promise<0 | 1> {
  const current = challenges.get(input.challenge_id);
  const key = lockoutKey(input);
  const currentLockout = lockouts.get(key);
  if (
    current === undefined ||
    current.status !== "active" ||
    current.org_id !== input.org_id ||
    current.store_id !== input.store_id ||
    current.device_id !== input.device_id ||
    current.failed_attempts !== input.expected_failed_attempts ||
    current.failed_attempts >= current.max_attempts ||
    current.expires_at <= input.attempted_at ||
    (currentLockout?.locked_until ?? 0) > input.attempted_at ||
    (current.target_staff_id !== input.staff_id && current.approver_staff_id !== input.staff_id)
  ) {
    return 0;
  }
  challenges.set(current.challenge_id, Object.freeze({ ...current, status: "consumed" as const }));
  lockouts.delete(key);
  try {
    await commit?.();
  } catch (error) {
    challenges.set(current.challenge_id, current);
    if (currentLockout !== undefined) lockouts.set(key, currentLockout);
    throw error;
  }
  return 1;
}

export async function commitPgPinSuccess(
  client: PgPoolClient,
  input: PinSuccessMutation,
  requesterStaffId: string,
  commit: PinSuccessCommit | undefined,
): Promise<void> {
  await client.query(
    `DELETE FROM pin_lockouts
      WHERE org_id = $1
        AND store_id = $2
        AND staff_id = $3
        AND device_id = $4`,
    [input.org_id, input.store_id, input.staff_id, input.device_id],
  );
  await commit?.({
    client,
    tenant: Object.freeze({
      orgId: input.org_id,
      storeId: input.store_id,
      staffId: requesterStaffId,
    }),
  });
}
