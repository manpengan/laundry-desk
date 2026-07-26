import type { PinFailureMutation, PinLockoutRecord } from "./types.js";

export function advancePinLockoutWindow(
  current: PinLockoutRecord | null,
  input: PinFailureMutation,
  maxAttempts: number,
): PinLockoutRecord {
  const windowSeconds = input.locked_until - input.attempted_at;
  if (windowSeconds <= 0 || maxAttempts <= 0) {
    throw new RangeError("PIN lockout policy must be positive");
  }
  const withinWindow =
    current !== null && current.last_failed_at > input.attempted_at - windowSeconds;
  const failedAttempts = (withinWindow ? current.failed_attempts : 0) + 1;
  return Object.freeze({
    org_id: input.org_id,
    store_id: input.store_id,
    staff_id: input.staff_id,
    device_id: input.device_id,
    locked_until: failedAttempts >= maxAttempts ? input.locked_until : input.attempted_at,
    failed_attempts: failedAttempts,
    last_failed_at: input.attempted_at,
  });
}
