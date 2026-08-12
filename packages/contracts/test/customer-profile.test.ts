import { describe, expect, it } from "vitest";

import {
  CustomerDiscountPolicySetInputSchema,
  CustomerProfileGetInputSchema,
  CustomerProfileResultSchema,
  CustomerProfileSetInputSchema,
  customerDiscountPolicySetCommand,
  customerProfileGetQuery,
  customerProfileSetCommand,
} from "../src/commands/customer-profile.js";
import { MemberBenefitDefinitionSchema } from "../src/commands/member-benefits.js";

const CUSTOMER_ID = "10000000-0000-4000-8000-000000000001";
const ADDRESS_ID = "10000000-0000-4000-8000-000000000002";
const IDENTIFIER_ID = "10000000-0000-4000-8000-000000000003";

function profileInput() {
  return {
    customer_id: CUSTOMER_ID,
    expected_version: 0,
    gender: "unspecified",
    preferred_contact: "wechat",
    service_note: "仅使用合成测试备注",
    waivers: {
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: false,
    },
    addresses: [
      {
        label: "公司",
        recipient: "测试顾客",
        contact_phone: "+86 138 0000 0000",
        address: "合成测试路 1 号",
        is_default: true,
      },
    ],
    identifiers: [
      { kind: "vehicle_plate", value: "TEST-A123" },
      { kind: "tag", value: "synthetic-tag" },
    ],
    reason: "顾客资料更新",
  } as const;
}

describe("ADR-42 customer profile contracts", () => {
  it("accepts the bounded strict profile shape", () => {
    expect(CustomerProfileSetInputSchema.parse(profileInput())).toEqual(profileInput());
    expect(CustomerProfileGetInputSchema.parse({ customer_id: CUSTOMER_ID })).toEqual({
      customer_id: CUSTOMER_ID,
    });
  });

  it("rejects unknown tenant fields and multiple default addresses", () => {
    expect(() =>
      CustomerProfileSetInputSchema.parse({ ...profileInput(), org_id: CUSTOMER_ID }),
    ).toThrow();
    expect(() =>
      CustomerProfileSetInputSchema.parse({
        ...profileInput(),
        addresses: [profileInput().addresses[0], { ...profileInput().addresses[0], label: "住址" }],
      }),
    ).toThrow(/default/iu);
  });

  it("rejects unbounded addresses, identifiers and malformed contact phones", () => {
    expect(() =>
      CustomerProfileSetInputSchema.parse({
        ...profileInput(),
        addresses: Array.from({ length: 11 }, (_, index) => ({
          ...profileInput().addresses[0],
          label: `地址${index}`,
          is_default: index === 0,
        })),
      }),
    ).toThrow();
    expect(() =>
      CustomerProfileSetInputSchema.parse({
        ...profileInput(),
        identifiers: Array.from({ length: 21 }, (_, index) => ({
          kind: "external_ref",
          value: `ref-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      CustomerProfileSetInputSchema.parse({
        ...profileInput(),
        addresses: [{ ...profileInput().addresses[0], contact_phone: "<script>" }],
      }),
    ).toThrow();
    expect(() =>
      CustomerProfileSetInputSchema.parse({
        ...profileInput(),
        identifiers: [
          { kind: "vehicle_plate", value: "TEST-A123" },
          { kind: "vehicle_plate", value: " test a123 " },
        ],
      }),
    ).toThrow(/unique/iu);
  });

  it("keeps null and zero discount semantics distinct and bounded", () => {
    expect(
      CustomerDiscountPolicySetInputSchema.parse({
        customer_id: CUSTOMER_ID,
        expected_version: 2,
        discount_bps: null,
        reason: "恢复等级继承",
      }).discount_bps,
    ).toBeNull();
    expect(
      CustomerDiscountPolicySetInputSchema.parse({
        customer_id: CUSTOMER_ID,
        expected_version: 2,
        discount_bps: 0,
        reason: "显式不折扣",
      }).discount_bps,
    ).toBe(0);
    expect(() =>
      CustomerDiscountPolicySetInputSchema.parse({
        customer_id: CUSTOMER_ID,
        expected_version: 2,
        discount_bps: 10_001,
        reason: "非法",
      }),
    ).toThrow();
  });

  it("validates the full bounded query result", () => {
    expect(
      CustomerProfileResultSchema.parse({
        customer_id: CUSTOMER_ID,
        version: 1,
        gender: "female",
        preferred_contact: "phone",
        service_note: null,
        waivers: {
          skip_ticket_print: false,
          skip_label_print: true,
          skip_rack_assignment: false,
        },
        discount_bps: 1250,
        addresses: [
          {
            address_id: ADDRESS_ID,
            label: "住址",
            recipient: null,
            contact_phone: null,
            address: "合成测试路 2 号",
            is_default: true,
          },
        ],
        identifiers: [{ identifier_id: IDENTIFIER_ID, kind: "external_ref", value: "test-ref" }],
        updated_at: 1_723_456_789,
      }).version,
    ).toBe(1);
  });

  it("freezes permission, privacy and offline metadata", () => {
    expect(customerProfileSetCommand).toMatchObject({
      risk: "R3",
      invariants: ["rbac.customer_write", "customer.profile_version"],
      offline_mode: "denied",
      data_classification: "pii",
    });
    expect(customerDiscountPolicySetCommand).toMatchObject({
      risk: "R4",
      invariants: ["rbac.order_discount", "customer.profile_version"],
      offline_mode: "denied",
    });
    expect(customerProfileGetQuery).toMatchObject({
      risk: "R2",
      invariants: ["rbac.customer_read"],
      offline_mode: "denied",
      max_result_rows: 31,
    });
    expect(customerProfileSetCommand.input_redaction).toContainEqual({
      path: "/addresses",
      strategy: "remove",
    });
  });

  it("adds a bounded tier discount while keeping unknown fields strict", () => {
    expect(
      MemberBenefitDefinitionSchema.parse({
        kind: "tier",
        expected_version: 0,
        code: "gold",
        name: "金卡",
        status: "active",
        level: 3,
        discount_bps: 1000,
      }),
    ).toMatchObject({ kind: "tier", discount_bps: 1000 });
    expect(() =>
      MemberBenefitDefinitionSchema.parse({
        kind: "tier",
        expected_version: 0,
        code: "gold",
        name: "金卡",
        status: "active",
        level: 3,
        discount_bps: -1,
      }),
    ).toThrow();
  });
});
