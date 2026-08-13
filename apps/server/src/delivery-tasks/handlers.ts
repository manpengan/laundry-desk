import { randomUUID } from "node:crypto";

import {
  DeliveryTaskAssignInputSchema,
  DeliveryTaskGetInputSchema,
  DeliveryTaskGetResultSchema,
  DeliveryTaskMutationResultSchema,
  DeliveryTaskRespondInputSchema,
  DeliveryTasksListInputSchema,
  DeliveryTasksListResultSchema,
  DeliveryTaskTakeoverInputSchema,
  DeliveryTaskTransferInputSchema,
  createCommandError,
  type DeliveryTask,
} from "@laundry/contracts";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { DeliveryOrderStore } from "../delivery-orders/types.js";
import { requireFrozenDeliveryTask } from "./confirmation.js";
import type { DeliveryTaskMutationRequest, DeliveryTaskStore } from "./types.js";

export type DeliveryTaskHandlerDeps = Readonly<{
  store: DeliveryTaskStore;
  orders: Pick<DeliveryOrderStore, "get">;
  now?: () => number;
  newId?: () => string;
}>;

const failed = (): never => {
  throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
};
const unavailable = (): never => {
  throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
};

function auditView(task: DeliveryTask) {
  return Object.freeze({
    delivery_task_id: task.delivery_task_id,
    delivery_order_id: task.delivery_order_id,
    leg: task.leg,
    assignee_staff_id: task.assignee_staff_id,
    assigned_by_staff_id: task.assigned_by_staff_id,
    predecessor_task_id: task.predecessor_task_id,
    source: task.source,
    status: task.status,
    version: task.version,
    resolution_reason: task.resolution_reason,
  });
}

async function mutationOutcome(
  deps: DeliveryTaskHandlerDeps,
  context: Parameters<CommandHandler>[0],
  request: DeliveryTaskMutationRequest,
): Promise<HandlerOutcome> {
  const result = await deps.store.mutate(request);
  if (!result.ok) return failed();
  const order = await deps.orders.get(
    context.tenant.orgId,
    context.tenant.storeId,
    result.delivery_task.delivery_order_id,
  );
  if (order === null) throw new Error("Delivery task order disappeared after mutation");
  const eventType =
    request.operation === "assign"
      ? "delivery.task.assigned"
      : request.operation === "respond"
        ? `delivery.task.${request.decision === "accept" ? "accepted" : "rejected"}`
        : request.operation === "transfer"
          ? "delivery.task.transferred"
          : "delivery.task.taken_over";
  return Object.freeze({
    result: DeliveryTaskMutationResultSchema.parse({
      delivery_task: result.delivery_task,
      previous_task: result.previous_task,
    }),
    privacySubjectCustomerId: order.customer_id,
    audit: Object.freeze({
      entity: "delivery_task",
      entityId: result.delivery_task.delivery_task_id,
      ...(result.before === null ? {} : { beforeJson: JSON.stringify(auditView(result.before)) }),
      afterJson: JSON.stringify(
        Object.freeze({
          delivery_task: auditView(result.delivery_task),
          previous_task: result.previous_task === null ? null : auditView(result.previous_task),
        }),
      ),
    }),
    events: Object.freeze([
      Object.freeze({
        type: eventType,
        payload: Object.freeze({
          delivery_task_id: result.delivery_task.delivery_task_id,
          delivery_order_id: result.delivery_task.delivery_order_id,
          leg: result.delivery_task.leg,
          assignee_staff_id: result.delivery_task.assignee_staff_id,
          predecessor_task_id: result.delivery_task.predecessor_task_id,
          status: result.delivery_task.status,
          version: result.delivery_task.version,
        }),
      }),
    ]),
  });
}

function writeHandlers(deps: DeliveryTaskHandlerDeps): Readonly<Record<string, CommandHandler>> {
  const base = (context: Parameters<CommandHandler>[0]) => ({
    org_id: context.tenant.orgId,
    store_id: context.tenant.storeId,
    staff_id: context.actor.staffId,
    at: deps.now?.() ?? Math.floor(Date.now() / 1_000),
  });
  return Object.freeze({
    "delivery.task.assign": async (context) => {
      const input = DeliveryTaskAssignInputSchema.parse(context.parsed);
      requireFrozenDeliveryTask(context, "assign");
      return mutationOutcome(deps, context, {
        operation: "assign",
        ...base(context),
        ...input,
        delivery_task_id: deps.newId?.() ?? randomUUID(),
      });
    },
    "delivery.task.respond": async (context) => {
      const input = DeliveryTaskRespondInputSchema.parse(context.parsed);
      const frozen = requireFrozenDeliveryTask(context, "respond");
      return mutationOutcome(deps, context, {
        operation: "respond",
        ...base(context),
        ...input,
        expected_delivery_order_version: frozen.delivery_order_version,
        resolution_reason: input.resolution_reason ?? null,
      });
    },
    "delivery.task.transfer": async (context) => {
      const input = DeliveryTaskTransferInputSchema.parse(context.parsed);
      const frozen = requireFrozenDeliveryTask(context, "transfer");
      return mutationOutcome(deps, context, {
        operation: "transfer",
        ...base(context),
        ...input,
        expected_delivery_order_version: frozen.delivery_order_version,
        successor_task_id: deps.newId?.() ?? randomUUID(),
      });
    },
    "delivery.task.takeover": async (context) => {
      const input = DeliveryTaskTakeoverInputSchema.parse(context.parsed);
      const frozen = requireFrozenDeliveryTask(context, "takeover");
      return mutationOutcome(deps, context, {
        operation: "takeover",
        ...base(context),
        ...input,
        expected_delivery_order_version: frozen.delivery_order_version,
        successor_task_id: deps.newId?.() ?? randomUUID(),
      });
    },
  });
}

export function registerDeliveryTaskCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryTaskHandlerDeps,
): void {
  const handlers = writeHandlers(deps);
  for (const name of [
    "delivery.task.assign",
    "delivery.task.respond",
    "delivery.task.transfer",
    "delivery.task.takeover",
  ]) {
    registry.registerHandler(name, handlers[name]!);
  }
}

export function registerDeliveryTaskQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: DeliveryTaskHandlerDeps,
): void {
  registry.registerHandler("delivery.task.get", async (context) => {
    const input = DeliveryTaskGetInputSchema.parse(context.parsed);
    const task = await deps.store.get(
      context.tenant.orgId,
      context.tenant.storeId,
      input.delivery_task_id,
    );
    if (task === null) unavailable();
    return Object.freeze({ result: DeliveryTaskGetResultSchema.parse({ delivery_task: task }) });
  });
  registry.registerHandler("delivery.tasks.list", async (context) => {
    const input = DeliveryTasksListInputSchema.parse(context.parsed);
    const tasks = await deps.store.list(
      context.tenant.orgId,
      context.tenant.storeId,
      Object.freeze({ ...input, limit: input.limit ?? 50 }),
    );
    return Object.freeze({
      result: DeliveryTasksListResultSchema.parse({ delivery_tasks: tasks }),
    });
  });
}
