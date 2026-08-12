import {
  DeliveryPolicyConfirmationSummarySchema,
  DeliveryPolicySetInputSchema,
  createCommandError,
  type DeliveryPolicyConfirmationSummary,
  type DeliveryPolicySetInput,
} from "@laundry/contracts";

import { HandlerCommandError, type HandlerContext } from "../bus/types.js";
import type { PendingActionPreparer } from "../handlers/default-chain-hooks.js";

export function deliveryPolicyConfirmationSummary(
  input: DeliveryPolicySetInput,
): DeliveryPolicyConfirmationSummary {
  return DeliveryPolicyConfirmationSummarySchema.parse({
    kind: "delivery_policy",
    ...input,
  });
}

export function createDeliveryPolicyConfirmationPreparer(): PendingActionPreparer {
  return async (raw, context) => {
    if (context.definition.name !== "delivery.policy.set") return null;
    const input = DeliveryPolicySetInputSchema.parse(raw);
    const summary = deliveryPolicyConfirmationSummary(input);
    return Object.freeze({ authority: summary, summary });
  };
}

export function requireFrozenDeliveryPolicyConfirmation(
  context: HandlerContext,
  input: DeliveryPolicySetInput,
): void {
  if (context.request.confirmRef === undefined) return;
  const authority = DeliveryPolicyConfirmationSummarySchema.safeParse(
    context.confirmationAuthority,
  );
  const expected = deliveryPolicyConfirmationSummary(input);
  if (!authority.success || JSON.stringify(authority.data) !== JSON.stringify(expected)) {
    throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
  }
}
