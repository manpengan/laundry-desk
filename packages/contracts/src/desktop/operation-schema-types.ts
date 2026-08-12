import type { ZodType } from "zod";

import type {
  DesktopCommandExecuteInputSchema,
  DesktopCommandExecuteResultSchema,
  DesktopHealthGetInputSchema,
  DesktopHealthGetResultSchema,
  DesktopLoginInputSchema,
  DesktopLoginResultSchema,
  DesktopLogoutInputSchema,
  DesktopLogoutResultSchema,
  DesktopOfflineResumeResultSchema,
  DesktopPinChallengeInputSchema,
  DesktopPinChallengeResultSchema,
  DesktopPinVerifyInputSchema,
  DesktopPinVerifyResultSchema,
  DesktopQueryExecuteInputSchema,
  DesktopQueryExecuteResultSchema,
  DesktopRefreshInputSchema,
  DesktopRefreshResultSchema,
} from "./operations.js";
import type {
  DesktopOfflineResolveInputSchema,
  DesktopOfflineResolveResultSchema,
  DesktopOfflineResumeInputSchema,
  DesktopOfflineStatusInputSchema,
  DesktopOfflineStatusResultSchema,
} from "./offline-operations.js";
import type {
  DesktopPhotoDeleteInputSchema,
  DesktopPhotoDeleteResultSchema,
  DesktopPhotoReadInputSchema,
  DesktopPhotoReadResultSchema,
  DesktopPhotoUploadInputSchema,
  DesktopPhotoUploadResultSchema,
} from "./photo-operations.js";

export type DesktopOperationSchema<TInput extends ZodType, TResult extends ZodType> = Readonly<{
  input: TInput;
  result: TResult;
}>;

export type DesktopOperationSchemas = Readonly<{
  auth: Readonly<{
    login: DesktopOperationSchema<typeof DesktopLoginInputSchema, typeof DesktopLoginResultSchema>;
    refresh: DesktopOperationSchema<
      typeof DesktopRefreshInputSchema,
      typeof DesktopRefreshResultSchema
    >;
    pinChallenge: DesktopOperationSchema<
      typeof DesktopPinChallengeInputSchema,
      typeof DesktopPinChallengeResultSchema
    >;
    pinVerify: DesktopOperationSchema<
      typeof DesktopPinVerifyInputSchema,
      typeof DesktopPinVerifyResultSchema
    >;
    logout: DesktopOperationSchema<
      typeof DesktopLogoutInputSchema,
      typeof DesktopLogoutResultSchema
    >;
  }>;
  command: Readonly<{
    execute: DesktopOperationSchema<
      typeof DesktopCommandExecuteInputSchema,
      typeof DesktopCommandExecuteResultSchema
    >;
  }>;
  query: Readonly<{
    execute: DesktopOperationSchema<
      typeof DesktopQueryExecuteInputSchema,
      typeof DesktopQueryExecuteResultSchema
    >;
  }>;
  photo: Readonly<{
    upload: DesktopOperationSchema<
      typeof DesktopPhotoUploadInputSchema,
      typeof DesktopPhotoUploadResultSchema
    >;
    read: DesktopOperationSchema<
      typeof DesktopPhotoReadInputSchema,
      typeof DesktopPhotoReadResultSchema
    >;
    delete: DesktopOperationSchema<
      typeof DesktopPhotoDeleteInputSchema,
      typeof DesktopPhotoDeleteResultSchema
    >;
  }>;
  offline: Readonly<{
    resume: DesktopOperationSchema<
      typeof DesktopOfflineResumeInputSchema,
      typeof DesktopOfflineResumeResultSchema
    >;
    status: DesktopOperationSchema<
      typeof DesktopOfflineStatusInputSchema,
      typeof DesktopOfflineStatusResultSchema
    >;
    resolve: DesktopOperationSchema<
      typeof DesktopOfflineResolveInputSchema,
      typeof DesktopOfflineResolveResultSchema
    >;
  }>;
  health: Readonly<{
    get: DesktopOperationSchema<
      typeof DesktopHealthGetInputSchema,
      typeof DesktopHealthGetResultSchema
    >;
  }>;
}>;
