import {
  DeliveryEvidenceConfirmationSummarySchema,
  DeliveryEvidenceRecordInputSchema,
  createCommandError,
  type DeliveryEvidenceConfirmationSummary,
} from "@laundry/contracts";

import { HandlerCommandError, type HandlerContext } from "../bus/types.js";
import type { PendingActionPreparer } from "../handlers/default-chain-hooks.js";
import { attachmentSetDigest, type DeliveryEvidenceStore } from "./types.js";

export function createDeliveryEvidenceConfirmationPreparer(
  store: DeliveryEvidenceStore,
  customerForOrder: (orgId: string, storeId: string, orderId: string) => Promise<string | null>,
): PendingActionPreparer {
  return async (parsed, context) => {
    if (context.definition.name !== "delivery.evidence.record") return null;
    const input = DeliveryEvidenceRecordInputSchema.parse(parsed);
    const summary = await store.prepare({
      ...input,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      at: Math.floor(Date.now() / 1_000),
    });
    if (summary === null) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    const customerId = await customerForOrder(
      context.tenant.orgId,
      context.tenant.storeId,
      input.delivery_order_id,
    );
    if (customerId === null) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    return Object.freeze({ authority: summary, summary, privacySubjectCustomerId: customerId });
  };
}

function deny(): never {
  throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
}

export function requireFrozenDeliveryEvidence(
  context: HandlerContext,
): DeliveryEvidenceConfirmationSummary {
  const frozen = DeliveryEvidenceConfirmationSummarySchema.safeParse(context.confirmationAuthority);
  if (!frozen.success || context.request.confirmRef === undefined) deny();
  const summary = frozen.data;
  const input = DeliveryEvidenceRecordInputSchema.parse(context.parsed);
  if (
    summary.delivery_evidence_id !== input.delivery_evidence_id ||
    summary.delivery_order_id !== input.delivery_order_id ||
    summary.delivery_order_version !== input.expected_delivery_order_version ||
    summary.delivery_task_id !== input.delivery_task_id ||
    summary.delivery_task_version !== input.expected_delivery_task_version ||
    summary.leg !== input.leg ||
    summary.assignee_staff_id !== context.actor.staffId ||
    summary.event_kind !== input.event_kind ||
    summary.outcome !== input.outcome ||
    summary.exception_reason !== (input.exception_reason ?? null) ||
    summary.captured_at !== input.captured_at ||
    summary.has_gps !== (input.gps !== null) ||
    summary.attachment_set_digest !== attachmentSetDigest(input.attachment_ids)
  ) {
    deny();
  }
  return Object.freeze(summary);
}
