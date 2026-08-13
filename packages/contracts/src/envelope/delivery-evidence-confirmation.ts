import { z } from "zod";

import {
  DeliveryEvidenceEventKindSchema,
  DeliveryEvidenceExceptionReasonSchema,
  DeliveryEvidenceOutcomeSchema,
} from "../commands/delivery-evidence.js";
import { DeliveryTaskLegSchema } from "../commands/delivery-tasks.js";

const VersionSchema = z.number().int().positive().max(2_147_483_647);

/** Server-derived authority card; deliberately excludes coordinates and attachment identifiers. */
export const DeliveryEvidenceConfirmationSummarySchema = z.strictObject({
  kind: z.literal("delivery_evidence_record"),
  delivery_evidence_id: z.uuid(),
  delivery_order_id: z.uuid(),
  delivery_order_version: VersionSchema,
  delivery_task_id: z.uuid(),
  delivery_task_version: VersionSchema,
  leg: DeliveryTaskLegSchema,
  assignee_staff_id: z.uuid(),
  event_kind: DeliveryEvidenceEventKindSchema,
  outcome: DeliveryEvidenceOutcomeSchema,
  exception_reason: DeliveryEvidenceExceptionReasonSchema.nullable(),
  captured_at: z.number().int().nonnegative().max(4_294_967_295),
  has_gps: z.boolean(),
  photo_count: z.number().int().nonnegative().max(4),
  signature_count: z.number().int().nonnegative().max(4),
  attachment_set_digest: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type DeliveryEvidenceConfirmationSummary = z.infer<
  typeof DeliveryEvidenceConfirmationSummarySchema
>;
