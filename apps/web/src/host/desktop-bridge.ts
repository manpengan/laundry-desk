import type { LoginFormValues, PinChallengeRequest, PinVerifyRequest } from "../auth/types.js";
import type { PhotoReadVariant, PhotoUploadInput } from "./photo-port.js";

export type DesktopCommandInput =
  | Readonly<{
      name: string;
      body: unknown;
      confirm_ref?: never;
    }>
  | Readonly<{
      name: string;
      confirm_ref: string;
      body?: never;
    }>;

export type DesktopQueryInput = Readonly<{
  name: string;
  body: unknown;
}>;

/**
 * Renderer-safe desktop capability surface.
 *
 * The preload must expose only these named operations. Transport controls such
 * as URLs, methods, headers, cookies, tokens, generic fetch, or generic invoke
 * deliberately have no representation here.
 */
export type LaundryDesktopBridge = Readonly<{
  auth: Readonly<{
    login: (input: LoginFormValues) => Promise<unknown>;
    refresh: () => Promise<unknown>;
    pinChallenge: (input: PinChallengeRequest) => Promise<unknown>;
    pinVerify: (input: PinVerifyRequest) => Promise<unknown>;
    logout: () => Promise<unknown>;
  }>;
  command: Readonly<{
    execute: (input: DesktopCommandInput) => Promise<unknown>;
  }>;
  query: Readonly<{
    execute: (input: DesktopQueryInput) => Promise<unknown>;
  }>;
  photo?: Readonly<{
    upload: (input: PhotoUploadInput) => Promise<unknown>;
    read: (input: Readonly<{ photo_id: string; variant: PhotoReadVariant }>) => Promise<unknown>;
    delete: (input: Readonly<{ photo_id: string; delete_id: string }>) => Promise<unknown>;
  }>;
  offline?: Readonly<{
    resume: () => Promise<unknown>;
    status: () => Promise<unknown>;
    resolve: (
      input:
        | Readonly<{ queue_id: string; action: "retry" }>
        | Readonly<{
            queue_id: string;
            action: "discard";
            reason: string;
            confirm: "DISCARD";
          }>,
    ) => Promise<unknown>;
  }>;
  health: Readonly<{
    get: () => Promise<unknown>;
  }>;
}>;
