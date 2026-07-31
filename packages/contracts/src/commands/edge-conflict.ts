import { z } from "zod";

import { defineCommand, type CommandDefinition } from "../registry/definitions.js";

export const EdgeConflictDiscardInputSchema = z.strictObject({
  queue_id: z.uuid(),
  reason: z.string().trim().min(3).max(256),
  confirm: z.literal("DISCARD"),
});

type DiscardInput = typeof EdgeConflictDiscardInputSchema;

export const edgeConflictDiscardCommand: CommandDefinition<DiscardInput> = defineCommand({
  name: "edge.conflict.discard",
  version: "0.1.0",
  description: "Audit an operator decision to discard one server-recorded Edge replay conflict.",
  description_llm:
    "Require an administrator, exact DISCARD confirmation and a non-empty reason. Verify a non-success replay record exists; never update append-only replay rows.",
  input: EdgeConflictDiscardInputSchema,
  risk: "R3",
  invariants: ["rbac.edge_conflict_resolve"],
  idempotent: true,
  sideEffects: ["edge.conflict_discarded", "audit.edge_conflict_resolution"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const EDGE_CONFLICT_COMMANDS = Object.freeze([edgeConflictDiscardCommand] as const);
