import { createCommandError } from "@laundry/contracts";
import { HandlerCommandError } from "../bus/types.js";

export function cancellationInvariant(
  reason: "member_account_closed" | "member_payment_unlinked",
): never {
  throw new HandlerCommandError(createCommandError("INVARIANT_FAILED", { kind: "reason", reason }));
}
