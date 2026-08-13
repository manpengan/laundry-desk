import type {
  CustomerPortalBenefitsResult,
  CustomerPortalGarmentProgressResult,
  CustomerPortalGarmentsListResult,
  CustomerPortalLoginInput,
  CustomerPortalOrderGetResult,
  CustomerPortalOrderSummary,
  CustomerPortalReceiptResult,
  CustomerPortalProfileResult,
  CustomerPortalProfileUpdateInput,
  CustomerPortalWalletResult,
} from "@laundry/contracts";

export type CustomerPortalSessionIdentity = Readonly<{
  sessionId: string;
  orgId: string;
  storeId: string;
  customerId: string;
  csrfHash: string;
  authorityHash: string;
  expiresAt: Date;
}>;

export type CustomerPortalSessionSecrets = Readonly<{
  sessionHash: string;
  csrfHash: string;
  authorityHash: string;
}>;

export type CustomerPortalQueryName =
  | "customer.self_service.orders.list"
  | "customer.self_service.order.get"
  | "customer.self_service.receipt.get"
  | "customer.self_service.garments.list"
  | "customer.self_service.garment.progress"
  | "customer.self_service.wallet.get"
  | "customer.self_service.benefits.get"
  | "customer.self_service.profile.get";

export type CustomerPortalQueryResult =
  | Readonly<{ orders: readonly CustomerPortalOrderSummary[] }>
  | CustomerPortalOrderGetResult
  | CustomerPortalReceiptResult
  | CustomerPortalGarmentsListResult
  | CustomerPortalGarmentProgressResult
  | CustomerPortalWalletResult
  | CustomerPortalBenefitsResult
  | CustomerPortalProfileResult;

export type CustomerPortalStore = Readonly<{
  createSession(
    input: CustomerPortalLoginInput,
    secrets: CustomerPortalSessionSecrets,
  ): Promise<CustomerPortalSessionIdentity | null>;
  resolveSession(sessionHash: string): Promise<CustomerPortalSessionIdentity | null>;
  revokeSession(sessionHash: string, csrfHash: string, authorityHash: string): Promise<boolean>;
  executeQuery(
    identity: CustomerPortalSessionIdentity,
    sessionHash: string,
    name: CustomerPortalQueryName,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CustomerPortalQueryResult | null>;
  updateProfile(
    identity: CustomerPortalSessionIdentity,
    sessionHash: string,
    input: CustomerPortalProfileUpdateInput,
  ): Promise<CustomerPortalProfileResult>;
}>;

export class CustomerPortalSessionInvalidError extends Error {
  readonly code = "CUSTOMER_PORTAL_SESSION_INVALID";

  constructor() {
    super("Customer portal session is no longer active");
    this.name = "CustomerPortalSessionInvalidError";
  }
}

export class CustomerPortalProfileConflictError extends Error {
  readonly code = "CUSTOMER_PORTAL_PROFILE_CONFLICT";

  constructor() {
    super("Customer portal profile changed or conflicts with preserved addresses");
    this.name = "CustomerPortalProfileConflictError";
  }
}
