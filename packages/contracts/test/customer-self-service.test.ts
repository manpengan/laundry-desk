import { describe, expect, it } from "vitest";

import {
  CUSTOMER_SELF_SERVICE_QUERIES,
  CUSTOMER_SELF_SERVICE_QUERY_NAMES,
  CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
  CustomerPortalAuthoritySchema,
  customerPortalCookieNames,
  CustomerPortalGarmentProgressResultSchema,
  CustomerPortalEmptyInputSchema,
  CustomerPortalLoginInputSchema,
  CustomerPortalProfileUpdateInputSchema,
  CustomerPortalWalletResultSchema,
  CustomerPortalReceiptResultSchema,
  buildLaundryOpenApiDocument,
} from "../src/index.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const GARMENT = "22222222-2222-4222-8222-222222222222";

describe("customer self-service contracts", () => {
  it("freezes eight customer-session-only, PII-aware read queries", () => {
    expect(CUSTOMER_SELF_SERVICE_QUERY_NAMES).toEqual([
      "customer.self_service.orders.list",
      "customer.self_service.order.get",
      "customer.self_service.receipt.get",
      "customer.self_service.garments.list",
      "customer.self_service.garment.progress",
      "customer.self_service.wallet.get",
      "customer.self_service.benefits.get",
      "customer.self_service.profile.get",
    ]);
    expect(CUSTOMER_SELF_SERVICE_QUERIES).toHaveLength(8);
    expect(
      CUSTOMER_SELF_SERVICE_QUERIES.every(
        (query) =>
          query.kind === "query" &&
          query.risk === "R2" &&
          query.data_classification === "pii" &&
          query.offline_mode === "denied" &&
          query.result_redaction.length > 0,
      ),
    ).toBe(true);
  });

  it("keeps wallet amounts integral and the profile write customer-id free", () => {
    expect(
      CustomerPortalWalletResultSchema.safeParse({
        wallet: {
          account_status: "active",
          principal_cents: 1_000,
          bonus_cents: 200,
          balance_cents: 1_200,
          recent: [],
        },
      }).success,
    ).toBe(true);
    expect(
      CustomerPortalWalletResultSchema.safeParse({
        wallet: {
          account_status: "active",
          principal_cents: 1_000,
          bonus_cents: 200,
          balance_cents: 1_201,
          recent: [],
        },
      }).success,
    ).toBe(false);
    const profile = {
      expected_version: 0,
      preferred_contact: "sms",
      addresses: [
        {
          label: "家",
          recipient: "王女士",
          contact_phone: "13800000001",
          address: "示例路 1 号",
          is_default: true,
        },
      ],
    };
    expect(CustomerPortalProfileUpdateInputSchema.safeParse(profile).success).toBe(true);
    expect(
      CustomerPortalProfileUpdateInputSchema.safeParse({ ...profile, customer_id: ORDER }).success,
    ).toBe(false);
    expect(
      CustomerPortalProfileUpdateInputSchema.safeParse({
        ...profile,
        addresses: [...profile.addresses, { ...profile.addresses[0], label: "公司" }],
      }).success,
    ).toBe(false);
  });

  it("strictly validates the anti-enumeration login boundary", () => {
    expect(
      CustomerPortalLoginInputSchema.safeParse({
        org_code: "local",
        store_code: "main",
        phone: "13800000001",
        pickup_code: "PK0001",
      }).success,
    ).toBe(true);
    expect(
      CustomerPortalLoginInputSchema.safeParse({
        org_code: "local",
        store_code: "main",
        phone: "13800000001",
        pickup_code: "PK0001",
        customer_id: ORDER,
      }).success,
    ).toBe(false);
  });

  it("freezes a 256-bit per-tab authority header separate from the cookie", () => {
    expect(CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME).toBe("x-customer-portal-authority");
    expect(CustomerPortalAuthoritySchema.safeParse(`v1.${"a".repeat(43)}`).success).toBe(true);
    expect(CustomerPortalAuthoritySchema.safeParse(`v1.${"a".repeat(42)}`).success).toBe(false);
    expect(customerPortalCookieNames("4JTmFDNpK4VrlEIfOPnfGXbs5hq7DHpCNHMwcmLW2MA", true)).toEqual({
      session: "__Host-laundry_customer_session_4JTmFDNpK4VrlEIfOPnfGXbs5hq7DHpCNHMwcmLW2MA",
      csrf: "__Host-laundry_customer_csrf_4JTmFDNpK4VrlEIfOPnfGXbs5hq7DHpCNHMwcmLW2MA",
    });
    expect(customerPortalCookieNames("invalid", true)).toBeNull();
  });

  it("accepts integer-cent receipts and rejects internal or fractional fields", () => {
    const receipt = {
      receipt: {
        order_id: ORDER,
        ticket_no: "20260813-0001",
        business_date: "2026-08-13",
        original_cents: 2_000,
        discount_cents: 0,
        addon_cents: 0,
        urgent_cents: 0,
        freight_cents: 0,
        payable_cents: 2_000,
        paid_cents: 1_000,
        balance_cents: 1_000,
        created_at: "2026-08-13T01:00:00.000Z",
        lines: [],
        payments: [
          {
            payment_id: "33333333-3333-4333-8333-333333333333",
            method: "balance",
            kind: "pay",
            amount_cents: 1_000,
            at: "2026-08-13T01:00:00.000Z",
          },
        ],
      },
    };
    expect(CustomerPortalReceiptResultSchema.safeParse(receipt).success).toBe(true);
    expect(
      CustomerPortalReceiptResultSchema.safeParse({
        receipt: { ...receipt.receipt, payable_cents: 20.5 },
      }).success,
    ).toBe(false);
    expect(
      CustomerPortalReceiptResultSchema.safeParse({
        receipt: { ...receipt.receipt, internal_note: "secret" },
      }).success,
    ).toBe(false);
  });

  it("allows only authoritative status transitions without reason or staff metadata", () => {
    const value = {
      garment: {
        garment_id: GARMENT,
        order_id: ORDER,
        seq: 1,
        service_code: "wash",
        category_code: "shirt",
        color: null,
        brand: null,
        status: "washing",
      },
      progress: [
        {
          from_status: "received",
          to_status: "washing",
          at: "2026-08-13T01:10:00.000Z",
        },
      ],
    };
    expect(CustomerPortalGarmentProgressResultSchema.safeParse(value).success).toBe(true);
    expect(
      CustomerPortalGarmentProgressResultSchema.safeParse({
        ...value,
        progress: [{ ...value.progress[0], reason: "internal", staff_id: ORDER }],
      }).success,
    ).toBe(false);
  });

  it("documents dedicated customer cookie plus CSRF instead of staff bearer auth", () => {
    const document = buildLaundryOpenApiDocument();
    const operation = document.paths["/v1/queries/customer.self_service.orders.list"]?.post;
    expect(operation?.security).toEqual([
      {
        customerSession: [],
        customerTabAuthority: [],
        customerCsrfCookie: [],
        csrfHeader: [],
      },
    ]);
    expect(operation?.parameters?.map((parameter) => parameter.name)).toContain("x-csrf-token");
    expect(operation?.parameters?.map((parameter) => parameter.name)).toContain(
      CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
    );
    expect(JSON.stringify(operation)).not.toContain("bearerAuth");
    expect(document.components.securitySchemes.customerSession).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "__Host-laundry_customer_session_<sha256-selector>",
    });
    expect(document.components.securitySchemes.customerTabAuthority).toMatchObject({
      type: "apiKey",
      in: "header",
      name: CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
    });
    expect(document.components.securitySchemes.customerCsrfCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "__Host-laundry_customer_csrf_<sha256-selector>",
    });
  });

  it("publishes complete customer login, resume and logout operations", () => {
    const document = buildLaundryOpenApiDocument();
    const login = document.paths["/api/v2/customer/auth/login"]?.post;
    const session = document.paths["/api/v2/customer/auth/session"]?.get;
    const logout = document.paths["/api/v2/customer/auth/logout"]?.post;
    expect(login?.security).toEqual([{ customerTabAuthority: [] }]);
    expect(login?.responses["429"]?.headers?.["Retry-After"]).toBeDefined();
    expect(session?.security).toEqual([{ customerSession: [], customerTabAuthority: [] }]);
    expect(session?.requestBody).toBeUndefined();
    expect(logout?.security).toEqual([
      {
        customerSession: [],
        customerTabAuthority: [],
        customerCsrfCookie: [],
        csrfHeader: [],
      },
    ]);
    expect(logout?.parameters?.map((parameter) => parameter.name)).toEqual([
      CUSTOMER_PORTAL_AUTHORITY_HEADER_NAME,
      "x-csrf-token",
    ]);
    expect(CustomerPortalEmptyInputSchema.safeParse({}).success).toBe(true);
    expect(CustomerPortalEmptyInputSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(logout?.requestBody?.content["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/CustomerPortalEmptyInput",
    });
    expect(Object.keys(login?.responses ?? {})).toEqual([
      "200",
      "400",
      "401",
      "403",
      "415",
      "429",
      "500",
      "default",
    ]);
    expect(Object.keys(session?.responses ?? {})).toEqual([
      "200",
      "400",
      "401",
      "429",
      "500",
      "default",
    ]);
    expect(Object.keys(logout?.responses ?? {})).toEqual([
      "200",
      "400",
      "401",
      "403",
      "415",
      "500",
      "default",
    ]);
    expect(logout?.responses["429"]).toBeUndefined();
    for (const operation of [login, session, logout]) {
      for (const response of Object.values(operation?.responses ?? {})) {
        expect(response.headers?.["Cache-Control"]?.schema).toMatchObject({ const: "no-store" });
      }
    }
    expect(login?.responses["200"]?.headers?.["Set-Cookie"]).toBeDefined();
    expect(session?.responses["401"]?.headers?.["Set-Cookie"]).toBeDefined();
    expect(logout?.responses["200"]?.headers?.["Set-Cookie"]).toBeDefined();
    expect(logout?.responses["415"]?.headers?.["Set-Cookie"]).toBeUndefined();
  });

  it("publishes the dedicated profile CAS mutation with no-store conflict semantics", () => {
    const operation = buildLaundryOpenApiDocument().paths["/api/v2/customer/profile"]?.post;
    expect(operation?.requestBody?.content["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/CustomerPortalProfileUpdateInput",
    });
    expect(operation?.security).toEqual([
      {
        customerSession: [],
        customerTabAuthority: [],
        customerCsrfCookie: [],
        csrfHeader: [],
      },
    ]);
    expect(operation?.responses["409"]).toBeDefined();
    expect(operation?.responses["429"]?.headers?.["Retry-After"]).toBeDefined();
    for (const response of Object.values(operation?.responses ?? {})) {
      expect(response.headers?.["Cache-Control"]?.schema).toMatchObject({ const: "no-store" });
    }
  });
});
