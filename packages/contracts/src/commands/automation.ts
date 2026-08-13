import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import {
  AutomationPolicyApproveInputSchema,
  AutomationPolicyArchiveInputSchema,
  AutomationPolicyCreateInputSchema,
  AutomationPolicyGetInputSchema,
  AutomationPolicyListInputSchema,
  AutomationPolicyPauseInputSchema,
  AutomationPolicyResumeInputSchema,
  AutomationPolicyUpdateInputSchema,
  AutomationRunListInputSchema,
} from "./automation-shared.js";

const commonCommand = Object.freeze({
  idempotent: true,
  offline_mode: "denied" as const,
  data_classification: "internal" as const,
  input_redaction: Object.freeze([]),
  result_redaction: Object.freeze([]),
});

export const automationPolicyCreateCommand: CommandDefinition<
  typeof AutomationPolicyCreateInputSchema
> = defineCommand({
  ...commonCommand,
  name: "automation.policy.create",
  version: "0.1.0",
  description: "Create a current-store bounded automation policy awaiting administrator approval.",
  description_llm:
    "Create only the fixed notification automation policy shape. It stays pending and cannot run until separately approved.",
  input: AutomationPolicyCreateInputSchema,
  risk: "R2",
  invariants: ["rbac.automation_manage", "automation.tool_allowlisted"],
  sideEffects: ["automation.policy_created", "audit.automation_policy"],
});

export const automationPolicyUpdateCommand: CommandDefinition<
  typeof AutomationPolicyUpdateInputSchema
> = defineCommand({
  ...commonCommand,
  name: "automation.policy.update",
  version: "0.1.0",
  description: "Replace one current-store policy configuration and return it to pending approval.",
  description_llm:
    "Replace all bounded fields under optimistic concurrency. Any update clears approval and scheduling until re-approved.",
  input: AutomationPolicyUpdateInputSchema,
  risk: "R2",
  invariants: ["rbac.automation_manage", "automation.tool_allowlisted"],
  sideEffects: ["automation.policy_updated", "audit.automation_policy"],
});

export const automationPolicyApproveCommand: CommandDefinition<
  typeof AutomationPolicyApproveInputSchema
> = defineCommand({
  ...commonCommand,
  name: "automation.policy.approve",
  version: "0.1.0",
  description: "Approve and activate one bounded automation policy after a WYSIWYS confirmation.",
  description_llm:
    "R3 administrator confirmation activates only the frozen allowlisted tool, object filter, validity, schedule and daily limits.",
  input: AutomationPolicyApproveInputSchema,
  risk: "R3",
  invariants: ["rbac.automation_manage", "automation.policy_pending"],
  sideEffects: ["automation.policy_approved", "audit.automation_policy"],
});

export const automationPolicyPauseCommand: CommandDefinition<
  typeof AutomationPolicyPauseInputSchema
> = defineCommand({
  ...commonCommand,
  name: "automation.policy.pause",
  version: "0.1.0",
  description: "Immediately pause one current-store automation policy.",
  description_llm: "Fail closed by removing its next run and any expired lease.",
  input: AutomationPolicyPauseInputSchema,
  risk: "R1",
  invariants: ["rbac.automation_manage"],
  sideEffects: ["automation.policy_paused", "audit.automation_policy"],
});

export const automationPolicyResumeCommand: CommandDefinition<
  typeof AutomationPolicyResumeInputSchema
> = defineCommand({
  ...commonCommand,
  name: "automation.policy.resume",
  version: "0.1.0",
  description: "Resume an already approved and still-valid automation policy.",
  description_llm:
    "Resume never creates approval and cannot widen the frozen tool, filter, schedule or daily limits.",
  input: AutomationPolicyResumeInputSchema,
  risk: "R2",
  invariants: ["rbac.automation_manage", "automation.policy_approved"],
  sideEffects: ["automation.policy_resumed", "audit.automation_policy"],
});

export const automationPolicyArchiveCommand: CommandDefinition<
  typeof AutomationPolicyArchiveInputSchema
> = defineCommand({
  ...commonCommand,
  name: "automation.policy.archive",
  version: "0.1.0",
  description: "Terminally archive one current-store automation policy.",
  description_llm: "Archive disables scheduling and cannot be resumed.",
  input: AutomationPolicyArchiveInputSchema,
  risk: "R2",
  invariants: ["rbac.automation_manage"],
  sideEffects: ["automation.policy_archived", "audit.automation_policy"],
});

export const automationPoliciesListQuery: QueryDefinition<typeof AutomationPolicyListInputSchema> =
  defineQuery({
    name: "automation.policies.list",
    version: "0.1.0",
    description: "List bounded automation policies for the authenticated store.",
    description_llm: "Administrator-only operational metadata; no customer objects or arguments.",
    input: AutomationPolicyListInputSchema,
    risk: "R1",
    invariants: ["rbac.automation_manage"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: 50,
  });

export const automationPolicyGetQuery: QueryDefinition<typeof AutomationPolicyGetInputSchema> =
  defineQuery({
    name: "automation.policy.get",
    version: "0.1.0",
    description: "Read one current-store automation policy.",
    description_llm: "Returns bounded policy configuration and scheduling state only.",
    input: AutomationPolicyGetInputSchema,
    risk: "R1",
    invariants: ["rbac.automation_manage"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: 1,
  });

export const automationRunsListQuery: QueryDefinition<typeof AutomationRunListInputSchema> =
  defineQuery({
    name: "automation.runs.list",
    version: "0.1.0",
    description: "List bounded execution records for one current-store automation policy.",
    description_llm: "Returns hashes, counts, integer-fen amounts and safe status codes only.",
    input: AutomationRunListInputSchema,
    risk: "R1",
    invariants: ["rbac.automation_manage"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: 100,
  });

export const AUTOMATION_COMMANDS = Object.freeze([
  automationPolicyCreateCommand,
  automationPolicyUpdateCommand,
  automationPolicyApproveCommand,
  automationPolicyPauseCommand,
  automationPolicyResumeCommand,
  automationPolicyArchiveCommand,
] as const);
export const AUTOMATION_QUERIES = Object.freeze([
  automationPoliciesListQuery,
  automationPolicyGetQuery,
  automationRunsListQuery,
] as const);
export const AUTOMATION_COMMAND_NAMES = Object.freeze(
  AUTOMATION_COMMANDS.map((definition) => definition.name),
);
export const AUTOMATION_QUERY_NAMES = Object.freeze(
  AUTOMATION_QUERIES.map((definition) => definition.name),
);

export * from "./automation-shared.js";
