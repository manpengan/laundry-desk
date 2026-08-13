import { z } from "zod";

import { defineQuery, type QueryDefinition } from "../registry/definitions.js";
import { CustomerPreferredContactSchema } from "./customer-profile.js";

const SafeIntegerSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const CentsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const VersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const TimestampSchema = z.iso.datetime({ offset: true });
const BusinessDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const ContactPhoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[+0-9() -]+$/u, "Expected a phone-like contact value");

export const CustomerPortalWalletLedgerSchema = z.strictObject({
  ledger_id: z.uuid(),
  kind: z.enum(["topup", "pay", "reversal", "refund", "bonus_forfeit"]),
  principal_delta_cents: SafeIntegerSchema,
  bonus_delta_cents: SafeIntegerSchema,
  order_id: z.uuid().nullable(),
  business_date: BusinessDateSchema,
  at: TimestampSchema,
});

export const CustomerPortalWalletResultSchema = z.strictObject({
  wallet: z
    .strictObject({
      account_status: z.enum(["active", "frozen", "closed"]),
      principal_cents: CentsSchema,
      bonus_cents: CentsSchema,
      balance_cents: CentsSchema,
      recent: z.array(CustomerPortalWalletLedgerSchema).max(50),
    })
    .superRefine((value, context) => {
      if (value.principal_cents + value.bonus_cents !== value.balance_cents) {
        context.addIssue({
          code: "custom",
          path: ["balance_cents"],
          message: "Wallet balance must equal principal plus bonus",
        });
      }
    })
    .nullable(),
});

export const CustomerPortalBenefitsResultSchema = z.strictObject({
  benefits: z
    .strictObject({
      account_status: z.enum(["active", "frozen", "closed"]),
      tier: z
        .strictObject({
          name: z.string().trim().min(1).max(64),
          level: z.number().int().min(1).max(99),
          valid_until: BusinessDateSchema,
          status: z.enum(["active", "expired"]),
        })
        .nullable(),
      available_points: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      punch_cards: z
        .array(
          z.strictObject({
            asset_id: z.uuid(),
            name: z.string().trim().min(1).max(64),
            total_uses: z.number().int().positive().max(999),
            used_uses: z.number().int().nonnegative().max(999),
            remaining_uses: z.number().int().nonnegative().max(999),
            expires_on: BusinessDateSchema,
            status: z.enum(["active", "exhausted", "expired"]),
          }),
        )
        .max(50),
      coupons: z
        .array(
          z.strictObject({
            asset_id: z.uuid(),
            name: z.string().trim().min(1).max(64),
            discount_cents: CentsSchema,
            min_order_cents: CentsSchema,
            expires_on: BusinessDateSchema,
            status: z.enum(["active", "redeemed", "expired"]),
          }),
        )
        .max(50),
    })
    .nullable(),
});

export const CustomerPortalAddressInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(32),
  recipient: z.string().trim().min(1).max(64).nullable(),
  contact_phone: ContactPhoneSchema.nullable(),
  address: z.string().trim().min(1).max(256),
  is_default: z.boolean(),
});

export const CustomerPortalAddressViewSchema = CustomerPortalAddressInputSchema.extend({
  address_id: z.uuid(),
  source: z.enum(["store", "portal"]),
}).strict();

function requireSingleDefault(
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

export const CustomerPortalProfileResultSchema = z
  .strictObject({
    version: VersionSchema,
    preferred_contact: CustomerPreferredContactSchema,
    addresses: z.array(CustomerPortalAddressViewSchema).max(10),
  })
  .superRefine(requireSingleDefault);

export const CustomerPortalProfileUpdateInputSchema = z
  .strictObject({
    expected_version: VersionSchema,
    preferred_contact: CustomerPreferredContactSchema,
    addresses: z.array(CustomerPortalAddressInputSchema).max(10),
  })
  .superRefine(requireSingleDefault);

export const CustomerPortalProfileMutationResultSchema = CustomerPortalProfileResultSchema;
export const CustomerPortalAccountEmptyInputSchema = z.strictObject({});

function accountQuery(definition: {
  name: string;
  description: string;
  resultPath: string;
  max: number;
}): QueryDefinition<typeof CustomerPortalAccountEmptyInputSchema> {
  return defineQuery({
    name: definition.name,
    version: "1.0.0",
    description: definition.description,
    description_llm:
      "Customer-owned membership projection behind a dedicated customer session; never expose it as an AI tool.",
    input: CustomerPortalAccountEmptyInputSchema,
    risk: "R2",
    invariants: ["rbac.customer_self_service_subject"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [],
    result_redaction: [{ path: definition.resultPath, strategy: "mask" }],
    max_result_rows: definition.max,
  });
}

export const CUSTOMER_SELF_SERVICE_ACCOUNT_QUERIES = Object.freeze([
  accountQuery({
    name: "customer.self_service.wallet.get",
    description: "Read the signed-in customer's stored-value balance and recent ledger.",
    resultPath: "/wallet/recent/*/ledger_id",
    max: 51,
  }),
  accountQuery({
    name: "customer.self_service.benefits.get",
    description: "Read the signed-in customer's tier, points, punch cards and coupon bag.",
    resultPath: "/benefits/punch_cards/*/asset_id",
    max: 101,
  }),
  accountQuery({
    name: "customer.self_service.profile.get",
    description: "Read the signed-in customer's bounded addresses and notification preference.",
    resultPath: "/addresses",
    max: 11,
  }),
] as const);

export const CUSTOMER_SELF_SERVICE_ACCOUNT_QUERY_NAMES = Object.freeze(
  CUSTOMER_SELF_SERVICE_ACCOUNT_QUERIES.map((query) => query.name),
) as readonly [
  "customer.self_service.wallet.get",
  "customer.self_service.benefits.get",
  "customer.self_service.profile.get",
];

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type CustomerPortalWalletResult = DeepReadonly<
  z.output<typeof CustomerPortalWalletResultSchema>
>;
export type CustomerPortalBenefitsResult = DeepReadonly<
  z.output<typeof CustomerPortalBenefitsResultSchema>
>;
export type CustomerPortalProfileResult = DeepReadonly<
  z.output<typeof CustomerPortalProfileResultSchema>
>;
export type CustomerPortalProfileUpdateInput = DeepReadonly<
  z.output<typeof CustomerPortalProfileUpdateInputSchema>
>;
