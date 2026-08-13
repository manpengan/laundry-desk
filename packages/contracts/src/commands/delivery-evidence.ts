import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import { DeliveryOrderSchema } from "./delivery-orders.js";
import { DeliveryTaskLegSchema, DeliveryTaskSchema } from "./delivery-tasks.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_EPOCH_SECONDS = 4_294_967_295;
const VersionSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const EpochSchema = z.number().int().nonnegative().max(MAX_EPOCH_SECONDS);

export const DeliveryEvidenceEventKindSchema = z.enum(["pickup", "delivered", "exception"]);
export const DeliveryEvidenceOutcomeSchema = z.enum(["record_only", "complete_leg"]);
export const DeliveryEvidenceAttachmentKindSchema = z.enum(["photo", "signature"]);
export const DeliveryEvidenceExceptionReasonSchema = z.enum([
  "customer_unavailable",
  "access_blocked",
  "item_mismatch",
  "unsafe_location",
  "weather",
  "vehicle_issue",
  "other",
]);

export const DeliveryEvidenceGpsSchema = z.strictObject({
  latitude_e7: z.number().int().min(-900_000_000).max(900_000_000),
  longitude_e7: z.number().int().min(-1_800_000_000).max(1_800_000_000),
  accuracy_mm: z.number().int().nonnegative().max(100_000_000),
  captured_at: EpochSchema,
});

export const DeliveryEvidenceAttachmentSchema = z.strictObject({
  attachment_id: z.uuid(),
  kind: DeliveryEvidenceAttachmentKindSchema,
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  byte_size: z.number().int().positive().max(10_000_000),
  captured_at: EpochSchema,
});

export const DeliveryEvidenceSchema = z.strictObject({
  delivery_evidence_id: z.uuid(),
  delivery_order_id: z.uuid(),
  delivery_task_id: z.uuid(),
  leg: DeliveryTaskLegSchema,
  delivery_task_version: VersionSchema,
  assignee_staff_id: z.uuid(),
  event_kind: DeliveryEvidenceEventKindSchema,
  outcome: DeliveryEvidenceOutcomeSchema,
  exception_reason: DeliveryEvidenceExceptionReasonSchema.nullable(),
  captured_at: EpochSchema,
  gps: DeliveryEvidenceGpsSchema.nullable(),
  attachments: z.array(DeliveryEvidenceAttachmentSchema).max(4),
  recorded_at: EpochSchema,
});

export const DeliveryEvidenceRecordInputSchema = z
  .strictObject({
    delivery_evidence_id: z.uuid(),
    delivery_order_id: z.uuid(),
    delivery_task_id: z.uuid(),
    leg: DeliveryTaskLegSchema,
    expected_delivery_order_version: VersionSchema,
    expected_delivery_task_version: VersionSchema,
    event_kind: DeliveryEvidenceEventKindSchema,
    outcome: DeliveryEvidenceOutcomeSchema,
    exception_reason: DeliveryEvidenceExceptionReasonSchema.optional(),
    captured_at: EpochSchema,
    gps: DeliveryEvidenceGpsSchema.nullable(),
    attachment_ids: z
      .array(z.uuid())
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length, "attachment ids must be unique"),
  })
  .superRefine((input, context) => {
    const expectedKind = input.leg === "pickup" ? "pickup" : "delivered";
    if (input.event_kind !== "exception" && input.event_kind !== expectedKind) {
      context.addIssue({
        code: "custom",
        path: ["event_kind"],
        message: "event does not match leg",
      });
    }
    if ((input.event_kind === "exception") !== (input.exception_reason !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["exception_reason"],
        message: "only an exception requires one controlled reason",
      });
    }
    if (input.outcome === "complete_leg" && input.event_kind === "exception") {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "exception evidence cannot complete a leg",
      });
    }
    if (input.gps === null && input.attachment_ids.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["attachment_ids"],
        message: "evidence requires a GPS fix or an attachment",
      });
    }
    if (input.outcome === "complete_leg" && input.gps === null) {
      context.addIssue({ code: "custom", path: ["gps"], message: "completion requires GPS" });
    }
  });

export const DeliveryEvidenceListInputSchema = z.strictObject({
  delivery_task_id: z.uuid(),
  limit: z.number().int().positive().max(50).optional(),
});

export const DeliveryEvidenceRecordResultSchema = z.strictObject({
  evidence: DeliveryEvidenceSchema,
  delivery_order: DeliveryOrderSchema,
  delivery_task: DeliveryTaskSchema,
});
export const DeliveryEvidenceListResultSchema = z.strictObject({
  evidence: z.array(DeliveryEvidenceSchema).max(50),
});

export const DeliveryEvidenceUploadFieldsSchema = z.strictObject({
  attachment_id: z.uuid(),
  delivery_order_id: z.uuid(),
  delivery_task_id: z.uuid(),
  leg: DeliveryTaskLegSchema,
  expected_delivery_task_version: VersionSchema,
  kind: DeliveryEvidenceAttachmentKindSchema,
  captured_at: EpochSchema,
});
export const DeliveryEvidenceUploadResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ attachment: DeliveryEvidenceAttachmentSchema }),
});

export const deliveryEvidenceRecordCommand: CommandDefinition<
  typeof DeliveryEvidenceRecordInputSchema
> = defineCommand({
  name: "delivery.evidence.record",
  version: "1.0.0",
  description:
    "Append pickup, delivery or exception evidence and optionally complete its leg atomically.",
  description_llm:
    "Sensitive delivery evidence. Coordinates and media are never exposed to AI tools.",
  input: DeliveryEvidenceRecordInputSchema,
  risk: "R3",
  invariants: [
    "rbac.delivery_write",
    "delivery.accepted_assignee",
    "delivery.evidence_required",
    "delivery.atomic_completion",
  ],
  idempotent: true,
  sideEffects: ["delivery.evidence.recorded", "audit.delivery_evidence_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [
    { path: "/gps", strategy: "remove" },
    { path: "/attachment_ids", strategy: "remove" },
  ],
  result_redaction: [
    { path: "/evidence/gps", strategy: "remove" },
    { path: "/evidence/attachments", strategy: "remove" },
    { path: "/evidence/assignee_staff_id", strategy: "mask" },
  ],
});

export const deliveryEvidenceListQuery: QueryDefinition<typeof DeliveryEvidenceListInputSchema> =
  defineQuery({
    name: "delivery.evidence.list",
    version: "1.0.0",
    description: "List bounded append-only evidence for one accepted current-assignee task.",
    description_llm: "Sensitive delivery evidence. Never exposed to AI tools.",
    input: DeliveryEvidenceListInputSchema,
    risk: "R2",
    invariants: ["rbac.delivery_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: [{ path: "/evidence", strategy: "remove" }],
    max_result_rows: 50,
  });

export const DELIVERY_EVIDENCE_COMMANDS = Object.freeze([deliveryEvidenceRecordCommand] as const);
export const DELIVERY_EVIDENCE_QUERIES = Object.freeze([deliveryEvidenceListQuery] as const);
export const DELIVERY_EVIDENCE_COMMAND_NAMES = Object.freeze(
  DELIVERY_EVIDENCE_COMMANDS.map(({ name }) => name),
);
export const DELIVERY_EVIDENCE_QUERY_NAMES = Object.freeze(
  DELIVERY_EVIDENCE_QUERIES.map(({ name }) => name),
);

export type DeliveryEvidence = z.infer<typeof DeliveryEvidenceSchema>;
export type DeliveryEvidenceAttachment = z.infer<typeof DeliveryEvidenceAttachmentSchema>;
export type DeliveryEvidenceAttachmentKind = z.infer<typeof DeliveryEvidenceAttachmentKindSchema>;
export type DeliveryEvidenceGps = z.infer<typeof DeliveryEvidenceGpsSchema>;
export type DeliveryEvidenceExceptionReason = z.infer<typeof DeliveryEvidenceExceptionReasonSchema>;
export type DeliveryEvidenceRecordInput = z.infer<typeof DeliveryEvidenceRecordInputSchema>;
export type DeliveryEvidenceListInput = z.infer<typeof DeliveryEvidenceListInputSchema>;
export type DeliveryEvidenceUploadFields = z.infer<typeof DeliveryEvidenceUploadFieldsSchema>;
