import {
  DeliveryEvidenceListInputSchema,
  DeliveryEvidenceListResultSchema,
  DeliveryEvidenceRecordInputSchema,
  DeliveryEvidenceRecordResultSchema,
  createCommandError,
} from "@laundry/contracts";

import type { CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { DeliveryOrderStore } from "../delivery-orders/types.js";
import { requireFrozenDeliveryEvidence } from "./confirmation.js";
import type { DeliveryEvidenceStore } from "./types.js";
import type { DeliveryEvidenceFileStore } from "./file-store.js";

export type DeliveryEvidenceHandlerDeps = Readonly<{
  store: DeliveryEvidenceStore;
  orders: Pick<DeliveryOrderStore, "get">;
  now?: () => number;
  files?: DeliveryEvidenceFileStore;
}>;

const invariantFailed = (): never => {
  throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
};

function safeEvidenceView(
  input: Readonly<{
    delivery_evidence_id: string;
    delivery_order_id: string;
    delivery_task_id: string;
    leg: string;
    delivery_task_version: number;
    event_kind: string;
    outcome: string;
    exception_reason: string | null;
  }>,
) {
  return Object.freeze({ ...input });
}

export function registerDeliveryEvidenceCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryEvidenceHandlerDeps,
): void {
  registry.registerHandler("delivery.evidence.record", async (context) => {
    const input = DeliveryEvidenceRecordInputSchema.parse(context.parsed);
    const authority = requireFrozenDeliveryEvidence(context);
    const result = await deps.store.record({
      ...input,
      org_id: context.tenant.orgId,
      store_id: context.tenant.storeId,
      staff_id: context.actor.staffId,
      at: deps.now?.() ?? Math.floor(Date.now() / 1_000),
      authority,
    });
    if (!result.ok) return invariantFailed();
    const safeView = safeEvidenceView({
      delivery_evidence_id: result.evidence.delivery_evidence_id,
      delivery_order_id: result.evidence.delivery_order_id,
      delivery_task_id: result.evidence.delivery_task_id,
      leg: result.evidence.leg,
      delivery_task_version: result.evidence.delivery_task_version,
      event_kind: result.evidence.event_kind,
      outcome: result.evidence.outcome,
      exception_reason: result.evidence.exception_reason,
    });
    return Object.freeze({
      result: DeliveryEvidenceRecordResultSchema.parse({
        evidence: result.evidence,
        delivery_order: result.delivery_order,
        delivery_task: result.delivery_task,
      }),
      privacySubjectCustomerId: result.delivery_order.customer_id,
      audit: Object.freeze({
        entity: "delivery_evidence",
        entityId: result.evidence.delivery_evidence_id,
        afterJson: JSON.stringify(safeView),
      }),
      events: Object.freeze([
        Object.freeze({ type: "delivery.evidence.recorded", payload: safeView }),
        ...(result.evidence.outcome === "complete_leg"
          ? [
              Object.freeze({
                type: "delivery.leg.completed",
                payload: Object.freeze({
                  delivery_order_id: result.evidence.delivery_order_id,
                  delivery_task_id: result.evidence.delivery_task_id,
                  leg: result.evidence.leg,
                  delivery_order_version: result.delivery_order.version,
                  delivery_task_version: result.delivery_task.version,
                }),
              }),
            ]
          : []),
      ]),
    });
  });
}

export function registerDeliveryEvidenceQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryEvidenceHandlerDeps,
): void {
  registry.registerHandler("delivery.evidence.list", async (context) => {
    const input = DeliveryEvidenceListInputSchema.parse(context.parsed);
    const evidence = await deps.store.list(
      context.tenant.orgId,
      context.tenant.storeId,
      context.actor.staffId,
      input.delivery_task_id,
      input.limit ?? 50,
    );
    return Object.freeze({ result: DeliveryEvidenceListResultSchema.parse({ evidence }) });
  });
}
