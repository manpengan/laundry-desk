import type {
  StaffCredentialsCompleteInput,
  StaffCredentialsCompleteResult,
} from "../auth/types.js";
import {
  StaffCredentialSetupResultSchema,
  StaffCredentialsCompleteRequestSchema,
  StaffCredentialsCompleteResponseSchema,
  StaffCredentialsResetInputSchema,
  StaffCreateInputSchema,
} from "@laundry/contracts";
import { unwrapQueryResult } from "./customer-model.js";

export type StaffCredentialSetup = Readonly<{
  credential_setup_ref: string;
  target_staff_id: string;
  expires_at: number;
  status: "pending";
}>;

export type StaffCreateDraft = Readonly<{
  username: string;
  display_name: string;
  role: "admin" | "staff";
  privacy_admin: boolean;
  reason: string;
}>;

export type StaffCreateBody = Readonly<{
  username: string;
  display_name: string;
  role: "admin" | "staff";
  privacy_admin: boolean;
  reason: string;
}>;

export type StaffCreateBuildResult =
  | Readonly<{ ok: true; body: StaffCreateBody }>
  | Readonly<{
      ok: false;
      field: "username" | "display_name" | "reason";
      message: string;
    }>;

export type StaffCredentialDraft = Readonly<{
  password: string;
  password_confirmation: string;
  pin: string;
  pin_confirmation: string;
}>;

export type StaffCredentialBuildResult =
  | Readonly<{ ok: true; body: StaffCredentialsCompleteInput }>
  | Readonly<{
      ok: false;
      field: "password" | "password_confirmation" | "pin" | "pin_confirmation";
      message: string;
    }>;

export type StaffCredentialsResetBuildResult =
  | Readonly<{
      ok: true;
      body: Readonly<{
        target_staff_id: string;
        expected_permission_version: number;
        reason: string;
      }>;
    }>
  | Readonly<{ ok: false; field: "reason" | null; message: string }>;

export function buildStaffCreateBody(draft: StaffCreateDraft): StaffCreateBuildResult {
  const username = draft.username;
  const displayName = draft.display_name.trim();
  const reason = draft.reason.trim();
  const candidate = Object.freeze({
    username,
    display_name: displayName,
    role: draft.role,
    privacy_admin: draft.role === "admin" && draft.privacy_admin,
    reason,
  });
  const parsed = StaffCreateInputSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, body: Object.freeze(parsed.data) };
  const field = parsed.error.issues[0]?.path[0];
  if (field === "display_name") {
    return { ok: false, field, message: "员工姓名须为 1–128 个字符" };
  }
  if (field === "reason") {
    return { ok: false, field, message: "操作原因须为 1–256 个字符" };
  }
  return {
    ok: false,
    field: "username",
    message: "登录名须为 1–128 位可见 ASCII 字符，不能含空格",
  };
}

export function buildCredentialCompletion(
  credentialSetupRef: string,
  draft: StaffCredentialDraft,
): StaffCredentialBuildResult {
  const parsed = StaffCredentialsCompleteRequestSchema.safeParse({
    credential_setup_ref: credentialSetupRef,
    password: draft.password,
    pin: draft.pin,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      field: field === "pin" ? "pin" : "password",
      message: field === "pin" ? "PIN 须为 6–8 位数字" : "密码须为 12–256 个字符",
    };
  }
  if (draft.password_confirmation !== draft.password) {
    return { ok: false, field: "password_confirmation", message: "两次输入的密码不一致" };
  }
  if (draft.pin_confirmation !== draft.pin) {
    return { ok: false, field: "pin_confirmation", message: "两次输入的 PIN 不一致" };
  }
  return { ok: true, body: Object.freeze(parsed.data) };
}

export function buildStaffCredentialsResetBody(input: {
  target_staff_id: string;
  expected_permission_version: number;
  reason: string;
}): StaffCredentialsResetBuildResult {
  const parsed = StaffCredentialsResetInputSchema.safeParse({
    ...input,
    reason: input.reason.trim(),
  });
  if (parsed.success) return { ok: true, body: Object.freeze(parsed.data) };
  const reasonInvalid = parsed.error.issues.some((issue) => issue.path[0] === "reason");
  return reasonInvalid
    ? { ok: false, field: "reason", message: "重置原因须为 1–256 个字符" }
    : { ok: false, field: null, message: "员工权限状态无效，请刷新后重试" };
}

export function parseStaffCredentialSetup(value: unknown): StaffCredentialSetup | null {
  const data = unwrapQueryResult(value);
  const parsed = StaffCredentialSetupResultSchema.safeParse(data);
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function parseStaffCredentialsCompleteResult(
  value: unknown,
): StaffCredentialsCompleteResult | null {
  const parsed = StaffCredentialsCompleteResponseSchema.safeParse(value);
  return parsed.success ? Object.freeze(parsed.data) : null;
}
