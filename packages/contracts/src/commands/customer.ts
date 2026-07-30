/**
 * M2 skeleton customer archive (search + upsert).
 * Org-scoped profiles; not in OpenAPI freeze snapshot.
 */

import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

/** Mainland mobile; seed range 13800000xxx ok. Shared with order.receive. */
export const PhoneSchema = z
  .string()
  .regex(/^1[3-9]\d{9}$/u, "Expected mainland mobile (seed range 13800000xxx ok)");

export const CustomerSearchInputSchema = z.strictObject({
  /** Phone prefix or name contains (case-insensitive). Empty = newest first. */
  query: z.string().max(64).optional(),
  /** Hard row cap (handler default 20; must not exceed max_result_rows). */
  limit: z.number().int().positive().max(50).optional(),
});

export const CustomerUpsertInputSchema = z.strictObject({
  phone: PhoneSchema,
  name: z.string().min(1).max(64).optional(),
  note: z.string().max(256).optional(),
});

export const CustomerGetInputSchema = z.strictObject({
  customer_id: z.uuid(),
});

export const CustomerUpdateInputSchema = z
  .strictObject({
    customer_id: z.uuid(),
    phone: PhoneSchema.optional(),
    name: z.string().trim().min(1).max(64).nullable().optional(),
    note: z.string().trim().max(256).nullable().optional(),
  })
  .superRefine((input, context) => {
    if (input.phone === undefined && input.name === undefined && input.note === undefined) {
      context.addIssue({
        code: "custom",
        path: ["customer_id"],
        message: "At least one editable field is required",
      });
    }
  });

export const CustomerMergeInputSchema = z
  .strictObject({
    source_customer_id: z.uuid(),
    target_customer_id: z.uuid(),
    reason: z.string().trim().min(1).max(256),
  })
  .superRefine((input, context) => {
    if (input.source_customer_id === input.target_customer_id) {
      context.addIssue({
        code: "custom",
        path: ["target_customer_id"],
        message: "Source and target customers must differ",
      });
    }
  });

export const CustomerDuplicatesInputSchema = z.strictObject({
  customer_id: z.uuid(),
  limit: z.number().int().positive().max(20).optional(),
});

export const CustomerPrivacyStatusInputSchema = z.strictObject({
  customer_id: z.uuid(),
});

export const CustomerPrivacyEventsInputSchema = z.strictObject({
  customer_id: z.uuid(),
  limit: z.number().int().positive().max(50).optional(),
});

export const CustomerPrivacyExportInputSchema = z.strictObject({
  customer_id: z.uuid(),
  reason: z.string().trim().min(1).max(256),
});

export const CustomerAnonymizeInputSchema = z.strictObject({
  customer_id: z.uuid(),
  reason: z.string().trim().min(1).max(256),
  confirmation: z.literal("ANONYMIZE"),
});

type SearchInput = typeof CustomerSearchInputSchema;
type UpsertInput = typeof CustomerUpsertInputSchema;
type GetInput = typeof CustomerGetInputSchema;
type UpdateInput = typeof CustomerUpdateInputSchema;
type MergeInput = typeof CustomerMergeInputSchema;
type DuplicatesInput = typeof CustomerDuplicatesInputSchema;
type PrivacyStatusInput = typeof CustomerPrivacyStatusInputSchema;
type PrivacyEventsInput = typeof CustomerPrivacyEventsInputSchema;
type PrivacyExportInput = typeof CustomerPrivacyExportInputSchema;
type AnonymizeInput = typeof CustomerAnonymizeInputSchema;

/**
 * Search result row (documented for tests / handlers; not Zod-validated on wire).
 *
 * ```ts
 * { customer_id, phone, name, note, updated_at }
 * ```
 */
export type CustomerSearchRow = Readonly<{
  customer_id: string;
  phone_masked: string;
  name: string | null;
  updated_at: number;
}>;

export type CustomerSearchResult = Readonly<{
  customers: readonly CustomerSearchRow[];
}>;

export type CustomerUpsertResult = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  created: boolean;
}>;

export type CustomerDetailResult = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  updated_at: number;
}>;

export type CustomerDuplicateRow = Readonly<{
  customer_id: string;
  phone_masked: string;
  name: string | null;
  updated_at: number;
}>;

/** 客户搜索：手机号前缀或姓名包含；PII 结果需脱敏声明。 */
export const customerSearchQuery: QueryDefinition<SearchInput> = defineQuery({
  name: "customer.search",
  version: "0.2.0",
  description: "Search org customer profiles by phone prefix or name contains.",
  description_llm:
    "Return org-scoped active customer rows with a masked phone and no note. Match phone prefix or name substring. max 50 rows; default limit 20.",
  input: CustomerSearchInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [{ path: "/customers/*/phone_masked", strategy: "mask" }],
  max_result_rows: 50,
});

/** 客户建档/更新：按 org+phone upsert；柜台可离线 grant。 */
export const customerUpsertCommand: CommandDefinition<UpsertInput> = defineCommand({
  name: "customer.upsert",
  version: "0.2.0",
  description: "Create or update an org customer profile by phone.",
  description_llm:
    "Upsert customer by org+phone. Optional name/note. Returns customer_id, phone, name, created flag. Integer timestamps only.",
  input: CustomerUpsertInputSchema,
  risk: "R2",
  invariants: ["rbac.order_write"],
  idempotent: true,
  sideEffects: ["customer.upserted", "audit.customer_event"],
  offline_mode: "grant",
  data_classification: "pii",
  input_redaction: [{ path: "/phone", strategy: "mask" }],
  result_redaction: [{ path: "/phone", strategy: "mask" }],
});

export const customerGetQuery: QueryDefinition<GetInput> = defineQuery({
  name: "customer.get",
  version: "0.1.0",
  description: "Load one active customer profile by server id.",
  description_llm:
    "Return one active org-scoped customer profile with full phone and note for an authorized detail view.",
  input: CustomerGetInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [{ path: "/phone", strategy: "mask" }],
  max_result_rows: 1,
});

export const customerDuplicatesQuery: QueryDefinition<DuplicatesInput> = defineQuery({
  name: "customer.duplicates",
  version: "0.1.0",
  description: "Find bounded active duplicate candidates for one customer.",
  description_llm:
    "Return up to 20 same-name active customer candidates with masked phones; never return the source row.",
  input: CustomerDuplicatesInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [{ path: "/customers/*/phone_masked", strategy: "mask" }],
  max_result_rows: 20,
});

export const customerUpdateCommand: CommandDefinition<UpdateInput> = defineCommand({
  name: "customer.update",
  version: "0.1.0",
  description: "Edit one active customer profile by id.",
  description_llm:
    "Update an active org-scoped customer phone, name, or note. At least one field is required.",
  input: CustomerUpdateInputSchema,
  risk: "R3",
  invariants: ["rbac.order_write"],
  idempotent: true,
  sideEffects: ["customer.updated", "audit.customer_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [{ path: "/phone", strategy: "mask" }],
  result_redaction: [{ path: "/phone", strategy: "mask" }],
});

export const customerMergeCommand: CommandDefinition<MergeInput> = defineCommand({
  name: "customer.merge",
  version: "0.1.0",
  description: "Merge a duplicate source customer into an active target customer.",
  description_llm:
    "High-risk merge: redirect the source profile to a distinct active target and relink this store's order snapshots. The source id remains as an auditable redirect.",
  input: CustomerMergeInputSchema,
  risk: "R4",
  invariants: ["rbac.order_write"],
  idempotent: true,
  sideEffects: ["customer.merged", "audit.customer_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [],
});

export const customerPrivacyStatusQuery: QueryDefinition<PrivacyStatusInput> = defineQuery({
  name: "customer.privacy.status",
  version: "0.1.0",
  description: "Preview privacy retention blockers and retained record counts.",
  description_llm:
    "Return bounded org-wide active/retained order and photo counts for one active customer. Direct PII is excluded.",
  input: CustomerPrivacyStatusInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 1,
});

export const customerPrivacyEventsQuery: QueryDefinition<PrivacyEventsInput> = defineQuery({
  name: "customer.privacy.events",
  version: "0.1.0",
  description: "List bounded immutable privacy events for one customer.",
  description_llm:
    "Return up to 50 exported/anonymized event rows without customer PII or credential material.",
  input: CustomerPrivacyEventsInputSchema,
  risk: "R2",
  invariants: [],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 50,
});

export const customerPrivacyExportCommand: CommandDefinition<PrivacyExportInput> = defineCommand({
  name: "customer.privacy.export",
  version: "0.1.0",
  description: "Create an audited, bounded JSON export for one active customer.",
  description_llm:
    "High-risk org-wide export of one customer profile and at most 1000 related order snapshots. The operation appends a privacy event and audit row in the same transaction.",
  input: CustomerPrivacyExportInputSchema,
  risk: "R4",
  invariants: ["rbac.privacy_admin"],
  idempotent: false,
  sideEffects: ["customer.privacy_exported", "audit.customer_privacy_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [
    { path: "/customer/phone", strategy: "mask" },
    { path: "/orders/*/customer_phone", strategy: "mask" },
  ],
});

export const customerAnonymizeCommand: CommandDefinition<AnonymizeInput> = defineCommand({
  name: "customer.anonymize",
  version: "0.1.0",
  description: "Irreversibly remove direct PII while retaining accounting records.",
  description_llm:
    "R5 org-wide anonymization. Reject while any draft/open order exists; otherwise clear customer PII and terminal order name/phone snapshots, retaining opaque accounting rows and immutable privacy/audit events.",
  input: CustomerAnonymizeInputSchema,
  risk: "R5",
  invariants: ["rbac.privacy_admin"],
  idempotent: false,
  sideEffects: ["customer.anonymized", "audit.customer_privacy_event"],
  offline_mode: "denied",
  data_classification: "pii",
  input_redaction: [],
  result_redaction: [],
});

export const CUSTOMER_COMMANDS = Object.freeze([
  customerUpsertCommand,
  customerUpdateCommand,
  customerMergeCommand,
  customerPrivacyExportCommand,
  customerAnonymizeCommand,
] as const);

export const CUSTOMER_COMMAND_NAMES = Object.freeze(
  CUSTOMER_COMMANDS.map((command) => command.name),
) as readonly [
  "customer.upsert",
  "customer.update",
  "customer.merge",
  "customer.privacy.export",
  "customer.anonymize",
];

export const CUSTOMER_QUERIES = Object.freeze([
  customerSearchQuery,
  customerGetQuery,
  customerDuplicatesQuery,
  customerPrivacyStatusQuery,
  customerPrivacyEventsQuery,
] as const);

export const CUSTOMER_QUERY_NAMES = Object.freeze(
  CUSTOMER_QUERIES.map((query) => query.name),
) as readonly [
  "customer.search",
  "customer.get",
  "customer.duplicates",
  "customer.privacy.status",
  "customer.privacy.events",
];

/** M2 customer command catalog (server command registry). */
export const M2_CUSTOMER_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...CUSTOMER_COMMANDS]);

export const M2_CUSTOMER_COMMAND_NAMES = CUSTOMER_COMMAND_NAMES;

/** M2 customer query catalog (server query registry). */
export const M2_CUSTOMER_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze(
  [...CUSTOMER_QUERIES],
);

export const M2_CUSTOMER_QUERY_NAMES = CUSTOMER_QUERY_NAMES;
