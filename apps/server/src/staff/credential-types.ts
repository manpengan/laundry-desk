import type { StaffRecord } from "../identity/types.js";
import type { StaffAccessRow } from "./access-store.js";

export const STAFF_CREDENTIAL_SETUP_TTL_SECONDS = 15 * 60;

export type StaffRole = "admin" | "staff";
export type StaffCredentialPurpose = "create" | "reset";

export type StaffCreate = Readonly<{
  username: string;
  display_name: string;
  role: StaffRole;
  privacy_admin: boolean;
  reason: string;
}>;

export type StaffCredentialReset = Readonly<{
  target_staff_id: string;
  expected_permission_version: number;
  reason: string;
}>;

export type StaffCredentialIssue = Readonly<{
  setupRef: string;
  targetStaffId: string;
  roleRowId: string;
  createdAt: number;
  expiresAt: number;
}>;

export type StaffCredentialSetupResult = Readonly<{
  credential_setup_ref: string;
  target_staff_id: string;
  expires_at: number;
  status: "pending";
}>;

export type StaffCredentialComplete = Readonly<{
  credential_setup_ref: string;
  password_hash: string;
  pin_hash: string;
  now: number;
  device_id: string | null;
}>;

export type StaffCredentialCompleteResult = Readonly<{
  target_staff_id: string;
  permission_version: number;
  status: "active";
}>;

export type StaffCredentialMutationFailure =
  | "duplicate_username"
  | "not_found"
  | "stale"
  | "self_change"
  | "inactive"
  | "last_admin"
  | "last_privacy_admin"
  | "setup_pending";

export type StaffCredentialMutationResult =
  | Readonly<{
      ok: true;
      setup: StaffCredentialSetupResult;
      before?: StaffAccessRow;
      after: StaffAccessRow;
    }>
  | Readonly<{ ok: false; reason: StaffCredentialMutationFailure }>;

export type StaffCredentialCompletionResult =
  Readonly<{ ok: true; result: StaffCredentialCompleteResult }> | Readonly<{ ok: false }>;

export type StaffCredentialStore = Readonly<{
  create: (
    actorStaffId: string,
    input: StaffCreate,
    issue: StaffCredentialIssue,
  ) => Promise<StaffCredentialMutationResult>;
  reset: (
    actorStaffId: string,
    input: StaffCredentialReset,
    issue: StaffCredentialIssue,
  ) => Promise<StaffCredentialMutationResult>;
  complete: (
    actorStaffId: string,
    input: StaffCredentialComplete,
  ) => Promise<StaffCredentialCompletionResult>;
}>;

export type MemoryCredentialIdentityAdapter = Readonly<{
  orgId: string;
  findStaff: (staffId: string) => Promise<StaffRecord | null>;
  upsertStaff: (staff: StaffRecord) => void;
  revokeSessions: (staffId: string, now: number) => Promise<void>;
}>;
