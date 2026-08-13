import { randomUUID } from "node:crypto";

import {
  AutomationPolicyApproveInputSchema,
  AutomationPolicyArchiveInputSchema,
  AutomationPolicyCreateInputSchema,
  AutomationPolicyGetInputSchema,
  AutomationPolicyGetResultSchema,
  AutomationPolicyListInputSchema,
  AutomationPolicyListResultSchema,
  AutomationPolicyMutationResultSchema,
  AutomationPolicyPauseInputSchema,
  AutomationPolicySchema,
  AutomationPolicyResumeInputSchema,
  AutomationPolicyUpdateInputSchema,
  AutomationRunListInputSchema,
  AutomationRunListResultSchema,
  createCommandError,
  type AutomationPolicyDraft,
} from "@laundry/contracts";

import type { MutableQueryRegistry } from "../bus/query-registry.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import { HandlerCommandError, type CommandHandler } from "../bus/types.js";
import type {
  AutomationHandlerDeps,
  AutomationStoreContext,
  AutomationTransition,
} from "./types.js";

export type { AutomationHandlerDeps } from "./types.js";

const requireManager = (permissions: readonly string[] | undefined): void => {
  if (permissions?.includes("automation_manage") !== true) {
    throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
  }
};

function currentTime(deps: AutomationHandlerDeps): Date {
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  return now;
}

const contextFrom = (context: Parameters<CommandHandler>[0]): AutomationStoreContext =>
  Object.freeze({ client: context.client, tenant: context.tenant });

function draftFrom(input: AutomationPolicyDraft): AutomationPolicyDraft {
  return Object.freeze({
    name: input.name,
    tool: input.tool,
    object_filter: Object.freeze({
      ...input.object_filter,
      garment_statuses: Object.freeze([...input.object_filter.garment_statuses]),
    }),
    schedule: Object.freeze({
      ...input.schedule,
      days_of_week: Object.freeze([...input.schedule.days_of_week]),
    }),
    limits: Object.freeze({ ...input.limits }),
    valid_from: input.valid_from,
    valid_until: input.valid_until,
    reason: input.reason,
  });
}

function mutationAudit(policyId: string, operation: string, reason: string, policy: unknown) {
  return Object.freeze({
    entity: "automation_policy",
    entityId: policyId,
    afterJson: JSON.stringify({ operation, reason, policy }),
  });
}

async function requiredPolicy(
  deps: AutomationHandlerDeps,
  context: AutomationStoreContext,
  policyId: string,
) {
  const policy = await deps.store.get(context, policyId);
  if (policy === null) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
  return policy;
}

function createHandler(deps: AutomationHandlerDeps): CommandHandler {
  return async (context) => {
    requireManager(context.actor.permissions);
    const input = AutomationPolicyCreateInputSchema.parse(context.parsed);
    const id = randomUUID();
    const now = currentTime(deps);
    if (!(await deps.store.create(contextFrom(context), id, draftFrom(input), now))) {
      throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    }
    const policy = await requiredPolicy(deps, contextFrom(context), id);
    return Object.freeze({
      result: AutomationPolicyMutationResultSchema.parse({
        policy: AutomationPolicySchema.parse(policy),
      }),
      audit: mutationAudit(id, "create", input.reason, policy),
      events: Object.freeze([
        Object.freeze({
          type: "automation.policy_created",
          payload: Object.freeze({ policy_id: id }),
        }),
      ]),
    });
  };
}

function updateHandler(deps: AutomationHandlerDeps): CommandHandler {
  return async (context) => {
    requireManager(context.actor.permissions);
    const input = AutomationPolicyUpdateInputSchema.parse(context.parsed);
    const now = currentTime(deps);
    const changed = await deps.store.update(
      contextFrom(context),
      input.policy_id,
      input.expected_version,
      draftFrom(input),
      now,
    );
    if (!changed) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    const policy = await requiredPolicy(deps, contextFrom(context), input.policy_id);
    return Object.freeze({
      result: AutomationPolicyMutationResultSchema.parse({
        policy: AutomationPolicySchema.parse(policy),
      }),
      audit: mutationAudit(input.policy_id, "update", input.reason, policy),
      events: Object.freeze([
        Object.freeze({
          type: "automation.policy_updated",
          payload: Object.freeze({ policy_id: input.policy_id }),
        }),
      ]),
    });
  };
}

function transitionHandler(
  deps: AutomationHandlerDeps,
  operation: AutomationTransition,
): CommandHandler {
  const schema =
    operation === "approve"
      ? AutomationPolicyApproveInputSchema
      : operation === "pause"
        ? AutomationPolicyPauseInputSchema
        : operation === "resume"
          ? AutomationPolicyResumeInputSchema
          : AutomationPolicyArchiveInputSchema;
  return async (context) => {
    requireManager(context.actor.permissions);
    const input = schema.parse(context.parsed);
    const changed = await deps.store.transition(
      contextFrom(context),
      input.policy_id,
      input.expected_version,
      operation,
      currentTime(deps),
    );
    if (!changed) throw new HandlerCommandError(createCommandError("INVARIANT_FAILED"));
    const policy = await requiredPolicy(deps, contextFrom(context), input.policy_id);
    return Object.freeze({
      result: AutomationPolicyMutationResultSchema.parse({
        policy: AutomationPolicySchema.parse(policy),
      }),
      audit: mutationAudit(input.policy_id, operation, input.reason, policy),
      events: Object.freeze([
        Object.freeze({
          type: `automation.policy_${operation}d`,
          payload: Object.freeze({ policy_id: input.policy_id }),
        }),
      ]),
    });
  };
}

function listHandler(deps: AutomationHandlerDeps): CommandHandler {
  return async (context) => {
    requireManager(context.actor.permissions);
    const input = AutomationPolicyListInputSchema.parse(context.parsed);
    const policies = await deps.store.list(contextFrom(context), input.status, input.limit ?? 20);
    return Object.freeze({
      result: AutomationPolicyListResultSchema.parse({
        policies: policies.map((policy) => AutomationPolicySchema.parse(policy)),
      }),
    });
  };
}

function getHandler(deps: AutomationHandlerDeps): CommandHandler {
  return async (context) => {
    requireManager(context.actor.permissions);
    const input = AutomationPolicyGetInputSchema.parse(context.parsed);
    const policy = await deps.store.get(contextFrom(context), input.policy_id);
    if (policy === null) throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    return Object.freeze({
      result: AutomationPolicyGetResultSchema.parse({
        policy: AutomationPolicySchema.parse(policy),
      }),
    });
  };
}

function runsHandler(deps: AutomationHandlerDeps): CommandHandler {
  return async (context) => {
    requireManager(context.actor.permissions);
    const input = AutomationRunListInputSchema.parse(context.parsed);
    const policy = await deps.store.get(contextFrom(context), input.policy_id);
    if (policy === null) throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    const runs = await deps.store.listRuns(
      contextFrom(context),
      input.policy_id,
      input.limit ?? 20,
    );
    return Object.freeze({ result: AutomationRunListResultSchema.parse({ runs }) });
  };
}

export function registerAutomationCommands(
  registry: MutableCommandRegistry,
  deps: AutomationHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  registry.registerHandler("automation.policy.create", createHandler(deps));
  registry.registerHandler("automation.policy.update", updateHandler(deps));
  registry.registerHandler("automation.policy.approve", transitionHandler(deps, "approve"));
  registry.registerHandler("automation.policy.pause", transitionHandler(deps, "pause"));
  registry.registerHandler("automation.policy.resume", transitionHandler(deps, "resume"));
  registry.registerHandler("automation.policy.archive", transitionHandler(deps, "archive"));
  return Object.freeze([
    "automation.policy.create",
    "automation.policy.update",
    "automation.policy.approve",
    "automation.policy.pause",
    "automation.policy.resume",
    "automation.policy.archive",
  ]);
}

export function registerAutomationQueries(
  registry: MutableQueryRegistry,
  deps: AutomationHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  registry.registerHandler("automation.policies.list", listHandler(deps));
  registry.registerHandler("automation.policy.get", getHandler(deps));
  registry.registerHandler("automation.runs.list", runsHandler(deps));
  return Object.freeze([
    "automation.policies.list",
    "automation.policy.get",
    "automation.runs.list",
  ]);
}
