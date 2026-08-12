import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  StoreAuthorizedListInputSchema,
  StoreAuthorizedListResultSchema,
  StoreProfileSetInputSchema,
  StoreProfileSetResultSchema,
  storeAuthorizedListQuery,
  storeProfileSetCommand,
} from "../src/commands/store-management.js";

const CURRENT = Object.freeze({
  store_code: "main",
  store_name: "主店",
  timezone: "Asia/Taipei",
  profile_version: 3,
  updated_at: "2026-08-11T08:00:00.000Z",
  is_current: true,
});

describe("ADR-40 store management contracts", () => {
  it("keeps the authorized-store selector server-owned", () => {
    expect(StoreAuthorizedListInputSchema.parse({})).toEqual({});
    expect(() => StoreAuthorizedListInputSchema.parse({ org_id: randomUUID() })).toThrow();
    expect(() => StoreAuthorizedListInputSchema.parse({ store_id: randomUUID() })).toThrow();
    expect(() => StoreAuthorizedListInputSchema.parse({ limit: 1 })).toThrow();
  });

  it("validates one sorted, bounded directory with exactly one current store", () => {
    const other = Object.freeze({
      ...CURRENT,
      store_code: "west",
      store_name: "西店",
      updated_at: "2026-08-11T08:01:00.000Z",
      is_current: false,
    });
    const value = Object.freeze({
      returned_store_count: 2,
      truncated: false,
      stores: Object.freeze([CURRENT, other]),
    });
    expect(StoreAuthorizedListResultSchema.parse(value)).toEqual(value);
    expect(
      StoreAuthorizedListResultSchema.safeParse({ ...value, stores: [other, CURRENT] }).success,
    ).toBe(false);
    expect(
      StoreAuthorizedListResultSchema.safeParse({
        ...value,
        stores: [CURRENT, { ...other, is_current: true }],
      }).success,
    ).toBe(false);
    expect(
      StoreAuthorizedListResultSchema.safeParse({
        ...value,
        stores: [{ ...CURRENT, store_id: randomUUID() }, other],
      }).success,
    ).toBe(false);
    expect(
      StoreAuthorizedListResultSchema.safeParse({
        returned_store_count: 1,
        truncated: true,
        stores: [CURRENT],
      }).success,
    ).toBe(false);
  });

  it("allows only current-store name CAS inputs", () => {
    const input = {
      expected_profile_version: CURRENT.profile_version,
      store_name: "  新主店  ",
      reason: "  更正门店显示名称  ",
    };
    expect(StoreProfileSetInputSchema.parse(input)).toEqual({
      expected_profile_version: CURRENT.profile_version,
      store_name: "新主店",
      reason: "更正门店显示名称",
    });
    for (const forbidden of [
      { store_id: randomUUID() },
      { store_code: "west" },
      { org_id: randomUUID() },
      { timezone: "UTC" },
    ]) {
      expect(() => StoreProfileSetInputSchema.parse({ ...input, ...forbidden })).toThrow();
    }
    expect(StoreProfileSetResultSchema.parse({ store: CURRENT })).toEqual({ store: CURRENT });
  });

  it("freezes the query and R5 command outside offline and AI surfaces", () => {
    expect(storeAuthorizedListQuery).toMatchObject({
      name: "store.authorized.list",
      version: "0.1.0",
      risk: "R2",
      invariants: ["rbac.store_manage"],
      offline_mode: "denied",
      max_result_rows: 50,
    });
    expect(storeProfileSetCommand).toMatchObject({
      name: "store.profile.set",
      version: "0.1.0",
      risk: "R5",
      invariants: ["rbac.store_manage"],
      offline_mode: "denied",
    });
  });
});
