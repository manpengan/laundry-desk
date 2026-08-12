import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const NonNegativeVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ProfileReasonSchema = z.string().trim().min(1).max(256);
const ContactPhoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[+0-9() -]+$/u, "Expected a phone-like contact value");

export const CustomerGenderSchema = z.enum(["unspecified", "female", "male", "other"]);
export const CustomerPreferredContactSchema = z.enum(["none", "phone", "sms", "wechat"]);
export const CustomerIdentifierKindSchema = z.enum(["vehicle_plate", "tag", "external_ref"]);

export const CustomerProfileWaiversSchema = z.strictObject({
  skip_ticket_print: z.boolean(),
  skip_label_print: z.boolean(),
  skip_rack_assignment: z.boolean(),
});

export const CustomerAddressInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(32),
  recipient: z.string().trim().min(1).max(64).nullable(),
  contact_phone: ContactPhoneSchema.nullable(),
  address: z.string().trim().min(1).max(256),
  is_default: z.boolean(),
});

export const CustomerIdentifierInputSchema = z.strictObject({
  kind: CustomerIdentifierKindSchema,
  value: z.string().trim().min(1).max(64),
});

function requireSingleDefaultAddress(
  value: Readonly<{ addresses: readonly Readonly<{ is_default: boolean }>[] }>,
  context: z.RefinementCtx,
): void {
  if (value.addresses.filter((address) => address.is_default).length > 1) {
    context.addIssue({
      code: "custom",
      path: ["addresses"],
      message: "At most one address may be the default",
    });
  }
}

function normalizeIdentifier(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleUpperCase("en-US")
    .replace(/[\s-]+/gu, "");
}

function requireUniqueIdentifiers(
  value: Readonly<{
    identifiers: readonly Readonly<{ kind: string; value: string }>[];
  }>,
  context: z.RefinementCtx,
): void {
  const keys = value.identifiers.map(
    (identifier) => `${identifier.kind}:${normalizeIdentifier(identifier.value)}`,
  );
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      path: ["identifiers"],
      message: "Identifiers must be unique after normalization",
    });
  }
}

export const CustomerProfileSetInputSchema = z
  .strictObject({
    customer_id: z.uuid(),
    expected_version: NonNegativeVersionSchema,
    gender: CustomerGenderSchema,
    preferred_contact: CustomerPreferredContactSchema,
    service_note: z.string().trim().max(256).nullable(),
    waivers: CustomerProfileWaiversSchema,
    addresses: z.array(CustomerAddressInputSchema).max(10),
    identifiers: z.array(CustomerIdentifierInputSchema).max(20),
    reason: ProfileReasonSchema,
  })
  .superRefine((value, context) => {
    requireSingleDefaultAddress(value, context);
    requireUniqueIdentifiers(value, context);
  });

export const CustomerDiscountPolicySetInputSchema = z.strictObject({
  customer_id: z.uuid(),
  expected_version: NonNegativeVersionSchema,
  discount_bps: z.number().int().min(0).max(10_000).nullable(),
  reason: ProfileReasonSchema,
});

export const CustomerProfileGetInputSchema = z.strictObject({
  customer_id: z.uuid(),
});

export const CustomerAddressViewSchema = CustomerAddressInputSchema.extend({
  address_id: z.uuid(),
}).strict();

export const CustomerIdentifierViewSchema = CustomerIdentifierInputSchema.extend({
  identifier_id: z.uuid(),
}).strict();

export const CustomerProfileResultSchema = z
  .strictObject({
    customer_id: z.uuid(),
    version: NonNegativeVersionSchema,
    gender: CustomerGenderSchema,
    preferred_contact: CustomerPreferredContactSchema,
    service_note: z.string().max(256).nullable(),
    waivers: CustomerProfileWaiversSchema,
    discount_bps: z.number().int().min(0).max(10_000).nullable(),
    addresses: z.array(CustomerAddressViewSchema).max(10),
    identifiers: z.array(CustomerIdentifierViewSchema).max(20),
    updated_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .superRefine(requireSingleDefaultAddress);

export const CustomerProfileMutationResultSchema = z.strictObject({
  customer_id: z.uuid(),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  address_count: z.number().int().nonnegative().max(10),
  identifier_count: z.number().int().nonnegative().max(20),
});

const reasonRedaction = Object.freeze([{ path: "/reason", strategy: "mask" as const }]);

export const customerProfileSetCommand: CommandDefinition<typeof CustomerProfileSetInputSchema> =
  defineCommand({
    name: "customer.profile.set",
    version: "1.0.0",
    description: "Replace one customer's bounded extended profile with optimistic versioning.",
    description_llm:
      "Replace addresses, identifiers, contact preferences and operational waivers for one active org customer. Tenant, actor and timestamps are server-owned.",
    input: CustomerProfileSetInputSchema,
    risk: "R3",
    invariants: ["rbac.customer_write", "customer.profile_version"],
    idempotent: true,
    sideEffects: ["customer.profile_changed", "audit.customer_event"],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [
      { path: "/service_note", strategy: "mask" },
      { path: "/addresses", strategy: "remove" },
      { path: "/identifiers", strategy: "remove" },
      ...reasonRedaction,
    ],
    result_redaction: [],
  });

export const customerDiscountPolicySetCommand: CommandDefinition<
  typeof CustomerDiscountPolicySetInputSchema
> = defineCommand({
  name: "customer.discount_policy.set",
  version: "1.0.0",
  description: "Set or clear one customer's org-wide automatic discount override.",
  description_llm:
    "Set a server-authoritative basis-point override using the exact profile version. Null inherits an active tier, zero explicitly disables tier discount, and positive values grant a customer override.",
  input: CustomerDiscountPolicySetInputSchema,
  risk: "R4",
  invariants: ["rbac.order_discount", "customer.profile_version"],
  idempotent: true,
  sideEffects: ["customer.discount_policy_changed", "audit.customer_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: reasonRedaction,
  result_redaction: [],
});

export const customerProfileGetQuery: QueryDefinition<typeof CustomerProfileGetInputSchema> =
  defineQuery({
    name: "customer.profile.get",
    version: "1.0.0",
    description: "Load one active customer's bounded extended profile.",
    description_llm:
      "Return addresses, identifiers, service preferences, operational waivers and discount override for an explicitly selected active customer. This PII query is never exposed to AI tools.",
    input: CustomerProfileGetInputSchema,
    risk: "R2",
    invariants: ["rbac.customer_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: [
      { path: "/service_note", strategy: "mask" },
      { path: "/addresses", strategy: "remove" },
      { path: "/identifiers", strategy: "remove" },
    ],
    max_result_rows: 31,
  });

export const CUSTOMER_PROFILE_COMMANDS = Object.freeze([
  customerProfileSetCommand,
  customerDiscountPolicySetCommand,
] as const);

export const CUSTOMER_PROFILE_QUERIES = Object.freeze([customerProfileGetQuery] as const);
export const CUSTOMER_PROFILE_COMMAND_NAMES = Object.freeze(
  CUSTOMER_PROFILE_COMMANDS.map((definition) => definition.name),
);
export const CUSTOMER_PROFILE_QUERY_NAMES = Object.freeze(
  CUSTOMER_PROFILE_QUERIES.map((definition) => definition.name),
);

export type CustomerProfileSetInput = z.infer<typeof CustomerProfileSetInputSchema>;
export type CustomerDiscountPolicySetInput = z.infer<typeof CustomerDiscountPolicySetInputSchema>;
export type CustomerProfileResult = z.infer<typeof CustomerProfileResultSchema>;
export type CustomerProfileMutationResult = z.infer<typeof CustomerProfileMutationResultSchema>;
