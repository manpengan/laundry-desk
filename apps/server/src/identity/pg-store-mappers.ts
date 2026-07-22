/**
 * SQL row ↔ identity domain mappers for packages/db M1 tables.
 */

import type {
  EpochSeconds,
  PinChallengeRecord,
  RefreshTokenRecord,
  SessionRecord,
  StaffRecord,
} from "./types.js";

export const epochToDate = (epoch: EpochSeconds): Date => new Date(epoch * 1000);

export const dateToEpoch = (value: Date | string): EpochSeconds => {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
};

export type StaffRow = {
  id: string;
  org_id: string;
  username: string;
  password_hash: string;
  pin_hash: string | null;
  display_name: string;
  is_active: boolean;
  permission_version: number;
};

export const mapStaff = (row: StaffRow): StaffRecord =>
  Object.freeze({
    staff_id: row.id,
    org_id: row.org_id,
    username: row.username,
    password_hash: row.password_hash,
    pin_hash: row.pin_hash,
    display_name: row.display_name,
    is_active: row.is_active,
    permission_version: row.permission_version,
  });

export type SessionRow = {
  id: string;
  org_id: string;
  store_id: string;
  staff_id: string;
  device_id: string;
  session_version: number;
  permission_version: number;
  authentication_method: string;
  status: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
  family_id: string | null;
};

export const mapSession = (row: SessionRow): SessionRecord | null => {
  if (row.family_id === null) return null;
  if (row.status !== "active" && row.status !== "revoked") return null;
  if (
    row.authentication_method !== "password" &&
    row.authentication_method !== "pin" &&
    row.authentication_method !== "refresh"
  ) {
    return null;
  }
  return Object.freeze({
    session_id: row.id,
    session_version: row.session_version,
    org_id: row.org_id,
    store_id: row.store_id,
    staff_id: row.staff_id,
    device_id: row.device_id,
    permission_version: row.permission_version,
    authentication_method: row.authentication_method,
    status: row.status,
    family_id: row.family_id,
    created_at: dateToEpoch(row.created_at),
    revoked_at: row.revoked_at === null ? null : dateToEpoch(row.revoked_at),
  });
};

/** Domain active ↔ SQL open. */
export const pinStatusToSql = (status: "active" | "consumed"): string =>
  status === "active" ? "open" : "consumed";

export const pinStatusFromSql = (status: string): "active" | "consumed" | null => {
  if (status === "open" || status === "active") return "active";
  if (status === "consumed" || status === "exhausted" || status === "expired") {
    return "consumed";
  }
  return null;
};

export type PinRow = {
  id: string;
  org_id: string;
  store_id: string;
  device_id: string;
  session_id: string;
  session_version: number;
  purpose: string;
  target_staff_id: string | null;
  approver_staff_id: string | null;
  pending_action_ref: string | null;
  nonce: string;
  attempts: number;
  max_attempts: number;
  status: string;
  issued_at: Date | string;
  expires_at: Date | string;
  requester_staff_id: string | null;
};

export const mapPin = (row: PinRow): PinChallengeRecord | null => {
  const status = pinStatusFromSql(row.status);
  if (status === null) return null;
  if (row.purpose !== "quick_switch" && row.purpose !== "step_up") return null;
  const requester = row.requester_staff_id;
  if (requester === null) return null;
  const base = {
    challenge_id: row.id,
    session_id: row.session_id,
    session_version: row.session_version,
    org_id: row.org_id,
    store_id: row.store_id,
    device_id: row.device_id,
    nonce: row.nonce,
    issued_at: dateToEpoch(row.issued_at),
    expires_at: dateToEpoch(row.expires_at),
    status,
    failed_attempts: row.attempts,
    max_attempts: row.max_attempts,
    requester_staff_id: requester,
  };
  if (row.purpose === "quick_switch") {
    if (row.target_staff_id === null) return null;
    return Object.freeze({
      ...base,
      purpose: "quick_switch" as const,
      target_staff_id: row.target_staff_id,
    });
  }
  return Object.freeze({
    ...base,
    purpose: "step_up" as const,
    ...(row.approver_staff_id !== null ? { approver_staff_id: row.approver_staff_id } : {}),
    ...(row.pending_action_ref !== null ? { pending_action_ref: row.pending_action_ref } : {}),
  });
};

export type TokenRow = {
  id: string;
  family_id: string;
  session_id: string;
  token_hash: string;
  status: string;
  replacement_token_id: string | null;
  expires_at: Date | string;
};

export const mapToken = (
  row: TokenRow,
): Exclude<RefreshTokenRecord, { status: "unknown" }> | null => {
  const expires_at = dateToEpoch(row.expires_at);
  if (row.status === "active") {
    return Object.freeze({
      status: "active" as const,
      token_id: row.id,
      family_id: row.family_id,
      session_id: row.session_id,
      token_hash: row.token_hash,
      expires_at,
    });
  }
  if (row.status === "rotated") {
    if (row.replacement_token_id === null) return null;
    return Object.freeze({
      status: "rotated" as const,
      token_id: row.id,
      family_id: row.family_id,
      session_id: row.session_id,
      token_hash: row.token_hash,
      expires_at,
      replacement_token_id: row.replacement_token_id,
    });
  }
  if (row.status === "revoked") {
    return Object.freeze({
      status: "revoked" as const,
      token_id: row.id,
      family_id: row.family_id,
      session_id: row.session_id,
      token_hash: row.token_hash,
      expires_at,
    });
  }
  return null;
};
