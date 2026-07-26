/**
 * Browser-facing auth shapes aligned with A5 contracts
 * (`packages/contracts/src/auth/operations.ts`).
 * Access tokens stay memory-only — never Web Storage / cookies from SPA code.
 */

import type { StaffRole } from "./permissions.js";

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
}>;

/** Memory-held access session (A5: storage = memory_only). */
export type AccessSession = Readonly<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  storage: "memory_only";
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
  /** Server-owned UI labels adjacent to the access-token response. */
  display: Readonly<{
    store_name: string;
    staff_name: string;
    org_code: string;
    store_code: string;
  }>;
}>;

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
