import type {
  DesktopCommandExecuteResult,
  DesktopHealthGetResult,
  DesktopLoginResult,
  DesktopLogoutResult,
  DesktopPinChallengeResult,
  DesktopPinVerifyResult,
  DesktopPhotoDeleteResult,
  DesktopPhotoReadResult,
  DesktopPhotoUploadResult,
  DesktopQueryExecuteResult,
  DesktopRefreshResult,
  DesktopSessionView,
  EdgeAuthorityResponse,
  EdgeQueueEnvelope,
} from "@laundry/contracts";

import type { EdgePrintHttpTransport } from "./print-http-transport.js";
import type { DesktopStaffCredentialCompleteResult } from "./staff-setup-operation.js";
import type { DesktopStaffDirectoryResult } from "./staff-directory-operation.js";

export type DesktopHttpTransport = Readonly<{
  auth: Readonly<{
    login: (input: unknown) => Promise<DesktopLoginResult>;
    refresh: () => Promise<DesktopRefreshResult>;
    staffDirectory: () => Promise<DesktopStaffDirectoryResult>;
    pinChallenge: (input: unknown) => Promise<DesktopPinChallengeResult>;
    pinVerify: (input: unknown) => Promise<DesktopPinVerifyResult>;
    credentialComplete: (input: unknown) => Promise<DesktopStaffCredentialCompleteResult>;
    logout: () => Promise<DesktopLogoutResult>;
  }>;
  command: Readonly<{
    execute: (input: unknown) => Promise<DesktopCommandExecuteResult>;
  }>;
  query: Readonly<{
    execute: (input: unknown) => Promise<DesktopQueryExecuteResult>;
  }>;
  photo: Readonly<{
    upload: (input: unknown) => Promise<DesktopPhotoUploadResult>;
    read: (input: unknown) => Promise<DesktopPhotoReadResult>;
    delete: (input: unknown) => Promise<DesktopPhotoDeleteResult>;
  }>;
  health: Readonly<{
    get: () => Promise<DesktopHealthGetResult>;
  }>;
  /** Main-process-only authority/replay surface. Never project this through preload. */
  edge: Readonly<{
    authority: (requestNonce: string, requestPrimary: boolean) => Promise<EdgeAuthorityResponse>;
    replay: (envelope: EdgeQueueEnvelope) => Promise<DesktopCommandExecuteResult>;
    print: EdgePrintHttpTransport;
    currentSession: () => DesktopSessionView | null;
  }>;
}>;
