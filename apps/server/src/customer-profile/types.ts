import type {
  CustomerDiscountPolicySetInput,
  CustomerProfileResult,
  CustomerProfileSetInput,
} from "@laundry/contracts";

export type CustomerProfileMutationContext = Readonly<{
  store_id: string;
  staff_id: string;
  at: number;
}>;

export type CustomerProfileSetStoreInput = CustomerProfileSetInput & CustomerProfileMutationContext;

export type CustomerDiscountSetStoreInput = CustomerDiscountPolicySetInput &
  CustomerProfileMutationContext;

export type CustomerProfileView = Readonly<
  Omit<CustomerProfileResult, "waivers" | "addresses" | "identifiers"> & {
    waivers: Readonly<CustomerProfileResult["waivers"]>;
    addresses: readonly Readonly<CustomerProfileResult["addresses"][number]>[];
    identifiers: readonly Readonly<CustomerProfileResult["identifiers"][number]>[];
  }
>;

export type CustomerProfileStore = Readonly<{
  get: (customerId: string) => Promise<CustomerProfileView | null>;
  getForOrder?: (customerId: string) => Promise<CustomerProfileView | null>;
  listPrivacyProfiles?: (customerId: string) => Promise<readonly CustomerProfileView[]>;
  findCustomerIdsByIdentifier?: (value: string) => Promise<readonly string[]>;
  setProfile: (input: CustomerProfileSetStoreInput) => Promise<CustomerProfileView | null>;
  setDiscount: (input: CustomerDiscountSetStoreInput) => Promise<CustomerProfileView | null>;
  /** Memory backend hook; PostgreSQL anonymization purges these rows in SQL. */
  purgeCustomerPii?: (customerId: string, canonicalGroupIds?: readonly string[]) => Promise<void>;
}>;

export class CustomerIdentifierConflictError extends Error {
  constructor() {
    super("CUSTOMER_IDENTIFIER_CONFLICT");
    this.name = "CustomerIdentifierConflictError";
  }
}
