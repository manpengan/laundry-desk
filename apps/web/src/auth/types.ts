/**
 * Browser-facing auth shapes aligned with A5 contracts
 * (`packages/contracts/src/auth/operations.ts`).
 * Access tokens stay memory-only — never Web Storage / cookies from SPA code.
 */

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
  /** UI labels not part of JWT claims; filled by AuthClient mock / future API. */
  display: Readonly<{
    store_name: string;
    staff_name: string;
    org_code: string;
    store_code: string;
  }>;
}>;

export type PinChallengeRequest = Readonly<{
  purpose: "quick_switch";
  target_staff_id: string;
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

export type SwitchableStaff = Readonly<{
  staff_id: string;
  display_name: string;
}>;

export type AuthError = Readonly<{
  code: string;
  message: string;
}>;

export type AuthResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: AuthError }>;
