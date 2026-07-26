/**
 * Browser-facing auth shapes aligned with A5 contracts
 * (`packages/contracts/src/auth/operations.ts`).
 * Transport credentials are deliberately absent from every exported UI view.
 */

import type { StaffRole } from "./permissions.js";

type CredentialFreeView = Readonly<{
  access_token?: never;
  refresh_token?: never;
  token_type?: never;
  expires_in?: never;
  storage?: never;
  authorization?: never;
  cookie?: never;
  cookies?: never;
  header?: never;
  headers?: never;
  csrf?: never;
  csrf_token?: never;
}>;

export type LoginFormValues = Readonly<{
  org_code: string;
  store_code: string;
  username: string;
  password: string;
}>;

export type LoginRequest = LoginFormValues &
  Readonly<{
    device_id: string;
  }>;

export type BrowserSessionView = Readonly<{
  session_id: string;
  session_version: number;
  org_id: string;
  store_id: string;
  staff_id: string;
  device_id: string;
  permission_version: number;
}> &
  CredentialFreeView;

/** Token-free session projection safe for React state and renderer bridges. */
export type SessionView = Readonly<{
  session: BrowserSessionView;
  /**
   * Server-owned IA projection consumed by the UI gate; C8 still enforces.
   */
  role: StaffRole;
  /**
   * Server-owned store feature flags (e.g. ai_enabled, member_enabled).
   * They shape UI only; C8 still enforces.
   */
  features: Readonly<Record<string, boolean>>;
  /** Server-owned UI labels returned beside the private transport credentials. */
  display: Readonly<{
    store_name: string;
    staff_name: string;
    org_code: string;
    store_code: string;
  }> &
    CredentialFreeView;
}> &
  CredentialFreeView;

export type PinChallengeRequest =
  | Readonly<{
      purpose: "quick_switch";
      target_staff_id: string;
    }>
  | Readonly<{
      purpose: "step_up";
      pending_action_ref: string;
      approver_staff_id: string;
    }>;

export type PinChallengeResponse = Readonly<{
  challenge_id: string;
  purpose: "quick_switch" | "step_up";
  expires_at: number;
  max_attempts: number;
}>;

export type PinVerifyRequest = Readonly<{
  challenge_id: string;
  pin: string;
}>;

/** A5 step-up success: single-use proof; session actor unchanged. */
export type StepUpProofResult = Readonly<{
  step_up_proof_id: string;
  expires_at: number;
}>;

export type SwitchableStaff = Readonly<{
  staff_id: string;
  display_name: string;
  /** Directory projection for switch/step-up choices, not current-session authority. */
  role: StaffRole;
}>;

export type AuthError = Readonly<{
  code: string;
  message: string;
}>;

export type AuthResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: AuthError }>;
