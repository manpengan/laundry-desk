import { describe, expect, it } from "vitest";

import {
  STAFF_COMMAND_NAMES,
  StaffCreateInputSchema,
  StaffCredentialSetupResultSchema,
  StaffCredentialsCompleteRequestSchema,
  StaffCredentialsCompleteResponseSchema,
  StaffCredentialsResetInputSchema,
  staffCreateCommand,
  staffCredentialsResetCommand,
} from "../src/commands/staff.js";

const TARGET_ID = "11111111-1111-4111-8111-111111111111";
const SETUP_ID = "22222222-2222-4222-8222-222222222222";

describe("ADR-31 staff credential contracts", () => {
  it("keeps plaintext credentials outside both R5 command inputs", () => {
    expect(
      StaffCreateInputSchema.parse({
        username: "cashier-02",
        display_name: " 店员乙 ",
        role: "staff",
        privacy_admin: false,
        reason: " 新员工入职 ",
      }),
    ).toEqual({
      username: "cashier-02",
      display_name: "店员乙",
      role: "staff",
      privacy_admin: false,
      reason: "新员工入职",
    });
    expect(
      StaffCreateInputSchema.safeParse({
        username: "cashier-02",
        display_name: "店员乙",
        role: "staff",
        privacy_admin: false,
        reason: "新员工入职",
        password: "must-not-enter-command",
      }).success,
    ).toBe(false);
    expect(
      StaffCredentialsResetInputSchema.safeParse({
        target_staff_id: TARGET_ID,
        expected_permission_version: 2,
        reason: "遗忘密码",
        pin: "123456",
      }).success,
    ).toBe(false);
  });

  it("validates staff authority shape and bounded completion secrets", () => {
    expect(
      StaffCreateInputSchema.safeParse({
        username: "cashier 02",
        display_name: "店员乙",
        role: "staff",
        privacy_admin: false,
        reason: "入职",
      }).success,
    ).toBe(false);
    expect(
      StaffCreateInputSchema.safeParse({
        username: "cashier-02",
        display_name: "店员乙",
        role: "staff",
        privacy_admin: true,
        reason: "入职",
      }).success,
    ).toBe(false);
    expect(
      StaffCredentialsCompleteRequestSchema.parse({
        credential_setup_ref: SETUP_ID,
        password: "correct horse battery staple",
        pin: "123456",
      }),
    ).toEqual({
      credential_setup_ref: SETUP_ID,
      password: "correct horse battery staple",
      pin: "123456",
    });
    expect(
      StaffCredentialsCompleteRequestSchema.safeParse({
        credential_setup_ref: SETUP_ID,
        password: "too-short",
        pin: "1234",
      }).success,
    ).toBe(false);
  });

  it("freezes two R5 commands and browser-safe result schemas", () => {
    expect(STAFF_COMMAND_NAMES).toEqual([
      "staff.access.set",
      "staff.create",
      "staff.credentials.reset",
    ]);
    expect(staffCreateCommand).toMatchObject({ risk: "R5", offline_mode: "denied" });
    expect(staffCredentialsResetCommand).toMatchObject({ risk: "R5", offline_mode: "denied" });
    expect(Object.keys(StaffCreateInputSchema.shape)).not.toEqual(
      expect.arrayContaining(["password", "pin", "password_hash", "pin_hash"]),
    );
    expect(Object.keys(StaffCredentialsResetInputSchema.shape)).not.toEqual(
      expect.arrayContaining(["password", "pin", "password_hash", "pin_hash"]),
    );
    expect(
      StaffCredentialSetupResultSchema.parse({
        credential_setup_ref: SETUP_ID,
        target_staff_id: TARGET_ID,
        expires_at: 2_000,
        status: "pending",
      }),
    ).toEqual({
      credential_setup_ref: SETUP_ID,
      target_staff_id: TARGET_ID,
      expires_at: 2_000,
      status: "pending",
    });
    expect(
      StaffCredentialsCompleteResponseSchema.parse({
        target_staff_id: TARGET_ID,
        permission_version: 3,
        status: "active",
      }),
    ).toEqual({ target_staff_id: TARGET_ID, permission_version: 3, status: "active" });
  });
});
