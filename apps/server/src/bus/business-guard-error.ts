import { createCommandError, type CommandError } from "@laundry/contracts";

const CHECK_VIOLATION = "23514";

function guardMessage(error: unknown): string | null {
  for (let current = error, depth = 0; depth < 4; depth++) {
    if (typeof current !== "object" || current === null) return null;
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (record.code === CHECK_VIOLATION && typeof record.message === "string")
      return record.message;
    current = record.cause;
  }
  return null;
}

/**
 * Database guards that staff can act on. Without this mapping they surfaced as an
 * opaque TRANSACTION_FAILED (HTTP 500) and the counter could not say why.
 */
export function businessGuardError(error: unknown): CommandError | null {
  switch (guardMessage(error)) {
    case "CHANNEL_PAYMENT_PENDING":
    case "CHANNEL_REFUND_PENDING":
      return createCommandError("RESOURCE_UNAVAILABLE", {
        kind: "reason",
        reason: "payment_pending",
      });
    case "CHANNEL_REFUND_REQUIRED":
      return createCommandError("POLICY_DENIED", {
        kind: "reason",
        reason: "channel_refund_required",
      });
    default:
      return null;
  }
}
