import {
  DeliveryTaskAssignInputSchema,
  DeliveryTaskConfirmationSummarySchema,
  DeliveryTaskRespondInputSchema,
  DeliveryTaskTakeoverInputSchema,
  DeliveryTaskTransferInputSchema,
  createCommandError,
  type DeliveryTaskConfirmationSummary,
} from "@laundry/contracts";

import { HandlerCommandError, type HandlerContext } from "../bus/types.js";
import type { PendingActionPreparer } from "../handlers/default-chain-hooks.js";
import type { DeliveryTaskHandlerDeps } from "./handlers.js";
import type { DeliveryTaskPrepareRequest } from "./types.js";

function scope(context: Parameters<PendingActionPreparer>[1]) {
  return Object.freeze({
    org_id: context.tenant.orgId,
    store_id: context.tenant.storeId,
    staff_id: context.actor.staffId,
  });
}

function prepareRequest(
  parsed: unknown,
  context: Parameters<PendingActionPreparer>[1],
): DeliveryTaskPrepareRequest | null {
  const base = scope(context);
  switch (context.definition.name) {
    case "delivery.task.assign":
      return Object.freeze({
        operation: "assign" as const,
        ...base,
        ...DeliveryTaskAssignInputSchema.parse(parsed),
      });
    case "delivery.task.respond": {
      const response = DeliveryTaskRespondInputSchema.parse(parsed);
      return Object.freeze({
        operation: "respond" as const,
        ...base,
        ...response,
        resolution_reason: response.resolution_reason ?? null,
      });
    }
    case "delivery.task.transfer":
      return Object.freeze({
        operation: "transfer" as const,
        ...base,
        ...DeliveryTaskTransferInputSchema.parse(parsed),
      });
    case "delivery.task.takeover":
      return Object.freeze({
        operation: "takeover" as const,
        ...base,
        ...DeliveryTaskTakeoverInputSchema.parse(parsed),
      });
    default:
      return null;
  }
}

export function createDeliveryTaskConfirmationPreparer(
  deps: DeliveryTaskHandlerDeps,
): PendingActionPreparer {
  return async (parsed, context) => {
    const request = prepareRequest(parsed, context);
    if (request === null) return null;
    const summary = await deps.store.prepare(request);
    if (summary === null) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    const order = await deps.orders.get(
      context.tenant.orgId,
      context.tenant.storeId,
      summary.delivery_order_id,
    );
    if (order === null) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    return Object.freeze({
      authority: summary,
      summary,
      privacySubjectCustomerId: order.customer_id,
    });
  };
}

function deny(): never {
  throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
}

function sameBase(
  summary: DeliveryTaskConfirmationSummary,
  context: HandlerContext,
  input: Readonly<{
    delivery_order_id: string;
    leg: "pickup" | "return";
    delivery_task_id?: string;
    expected_version?: number;
  }>,
): boolean {
  return (
    summary.delivery_order_id === input.delivery_order_id &&
    summary.leg === input.leg &&
    summary.delivery_task_id === (input.delivery_task_id ?? null) &&
    summary.delivery_task_version === (input.expected_version ?? null) &&
    summary.to_assignee_staff_id !== "" &&
    context.request.confirmRef !== undefined
  );
}

/** Validate exact frozen copy and return its order version for second-hop CAS. */
export function requireFrozenDeliveryTask(
  context: HandlerContext,
  operation: "assign" | "respond" | "transfer" | "takeover",
): DeliveryTaskConfirmationSummary {
  const frozen = DeliveryTaskConfirmationSummarySchema.safeParse(context.confirmationAuthority);
  if (!frozen.success || frozen.data.operation !== operation) deny();
  const summary = frozen.data;
  if (operation === "assign") {
    const input = DeliveryTaskAssignInputSchema.parse(context.parsed);
    if (
      !sameBase(summary, context, input) ||
      summary.delivery_order_version !== input.expected_delivery_order_version ||
      summary.to_assignee_staff_id !== input.assignee_staff_id
    ) {
      deny();
    }
  } else if (operation === "respond") {
    const input = DeliveryTaskRespondInputSchema.parse(context.parsed);
    if (
      !sameBase(summary, context, input) ||
      summary.from_assignee_staff_id !== context.actor.staffId ||
      summary.to_assignee_staff_id !== context.actor.staffId ||
      summary.decision !== input.decision ||
      summary.resolution_reason !== (input.resolution_reason ?? null)
    ) {
      deny();
    }
  } else if (operation === "transfer") {
    const input = DeliveryTaskTransferInputSchema.parse(context.parsed);
    if (
      !sameBase(summary, context, input) ||
      summary.to_assignee_staff_id !== input.target_staff_id ||
      summary.resolution_reason !== input.resolution_reason
    ) {
      deny();
    }
  } else {
    const input = DeliveryTaskTakeoverInputSchema.parse(context.parsed);
    if (
      !sameBase(summary, context, input) ||
      summary.to_assignee_staff_id !== context.actor.staffId ||
      summary.resolution_reason !== input.resolution_reason
    ) {
      deny();
    }
  }
  return Object.freeze(summary);
}
