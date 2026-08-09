import { createHash } from "node:crypto";
import { z } from "zod";

import type { PgPool } from "../db/pg-pool.js";
import type { PasswordPort } from "../identity/password.js";
import { LOCAL_FEATURE_PROFILE_VERSION } from "./bootstrap-constants.js";
import { LOCAL_PROFILE, type LocalProfile } from "./profile.js";

const PROFILE_HASH_VERSION = "laundry-local-bootstrap-v1";
const USERNAME = /^[A-Za-z0-9_.-]{1,64}$/u;
const PIN = /^\d{6,8}$/u;
const SAFE_SECRET = /^[^\0\r\n]+$/u;

export type BootstrapInput = Readonly<{
  profile: LocalProfile;
  adminUsername: string;
  adminDisplayName: string;
  adminPassword: string;
  adminPin: string;
  approverUsername: string;
  approverDisplayName: string;
  approverPassword: string;
  approverPin: string;
  demoOnly: boolean;
}>;

export type CommissionInput = Readonly<{
  profile: LocalProfile;
  approverUsername: string;
  approverDisplayName: string;
  approverPassword: string;
  approverPin: string;
}>;

export type BootstrapResult = Readonly<{
  status: "created" | "unchanged";
  orgId: string;
  storeId: string;
  adminStaffId: string;
  approverStaffId: string;
  demoOnly: boolean;
}>;

export type CommissionResult = Readonly<{
  status: "commissioned";
  orgId: string;
  storeId: string;
  adminStaffId: string;
  approverStaffId: string;
  featureProfileVersion: number;
}>;

export type BootstrapDependencies = Readonly<{
  pool: PgPool;
  passwordPort: PasswordPort;
  now?: () => Date;
}>;

export type HashedCredentials = Readonly<{ passwordHash: string; pinHash: string }>;

export type BootstrapErrorCode =
  | "BOOTSTRAP_COLLISION"
  | "BOOTSTRAP_DEMO_CONFLICT"
  | "BOOTSTRAP_HASH_FAILED"
  | "BOOTSTRAP_PREFLIGHT_FAILED"
  | "BOOTSTRAP_ROLLBACK_FAILED"
  | "BOOTSTRAP_STATE_CONFLICT"
  | "COMMISSION_ALREADY_COMPLETE"
  | "COMMISSION_COLLISION"
  | "COMMISSION_HASH_FAILED"
  | "COMMISSION_PREFLIGHT_FAILED"
  | "COMMISSION_ROLLBACK_FAILED"
  | "COMMISSION_STATE_CONFLICT";

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "BootstrapError";
    this.code = code;
  }
}

const FixedLocalProfileSchema: z.ZodType<LocalProfile> = z
  .object({
    orgId: z.literal(LOCAL_PROFILE.orgId),
    storeId: z.literal(LOCAL_PROFILE.storeId),
    adminStaffId: z.literal(LOCAL_PROFILE.adminStaffId),
    orgCode: z.literal(LOCAL_PROFILE.orgCode),
    storeCode: z.literal(LOCAL_PROFILE.storeCode),
    orgName: z.literal(LOCAL_PROFILE.orgName),
    storeName: z.literal(LOCAL_PROFILE.storeName),
    timezone: z.literal(LOCAL_PROFILE.timezone),
  })
  .strict()
  .readonly();

const username = () => z.string().regex(USERNAME, "must contain 1 to 64 safe characters");
const displayName = () => z.string().trim().min(1).max(80);
const password = () => z.string().min(12).max(256).regex(SAFE_SECRET, "must be one line");
const pin = () => z.string().regex(PIN, "must contain 6 to 8 digits");

const independentApprover = (
  value: Pick<
    BootstrapInput,
    | "adminUsername"
    | "adminPassword"
    | "adminPin"
    | "approverUsername"
    | "approverPassword"
    | "approverPin"
  >,
  context: z.RefinementCtx,
): void => {
  const comparisons = [
    ["approverUsername", value.adminUsername, value.approverUsername],
    ["approverPassword", value.adminPassword, value.approverPassword],
    ["approverPin", value.adminPin, value.approverPin],
  ] as const;
  for (const [field, first, second] of comparisons) {
    if (first === second) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "must differ from administrator",
      });
    }
  }
};

export const BootstrapInputSchema: z.ZodType<BootstrapInput> = z
  .object({
    profile: FixedLocalProfileSchema,
    adminUsername: username(),
    adminDisplayName: displayName(),
    adminPassword: password(),
    adminPin: pin(),
    approverUsername: username(),
    approverDisplayName: displayName(),
    approverPassword: password(),
    approverPin: pin(),
    demoOnly: z.boolean(),
  })
  .strict()
  .superRefine(independentApprover)
  .readonly();

export const CommissionInputSchema: z.ZodType<CommissionInput> = z
  .object({
    profile: FixedLocalProfileSchema,
    approverUsername: username(),
    approverDisplayName: displayName(),
    approverPassword: password(),
    approverPin: pin(),
  })
  .strict()
  .readonly();

type BootstrapProfileHashInput = Pick<
  BootstrapInput,
  "profile" | "adminUsername" | "adminDisplayName" | "demoOnly"
>;

const canonicalProfile = (input: BootstrapProfileHashInput): string =>
  JSON.stringify({
    version: PROFILE_HASH_VERSION,
    profile: input.profile,
    admin: { username: input.adminUsername, displayName: input.adminDisplayName },
    demoOnly: input.demoOnly,
  });

export const computeParsedProfileHash = (input: BootstrapProfileHashInput): string =>
  createHash("sha256").update(canonicalProfile(input), "utf8").digest("hex");

export const computeBootstrapProfileHash = (rawInput: BootstrapInput): string =>
  computeParsedProfileHash(BootstrapInputSchema.parse(rawInput));

export const resultFor = (
  input: BootstrapInput,
  approverStaffId: string,
  status: BootstrapResult["status"],
): BootstrapResult =>
  Object.freeze({
    status,
    orgId: input.profile.orgId,
    storeId: input.profile.storeId,
    adminStaffId: input.profile.adminStaffId,
    approverStaffId,
    demoOnly: input.demoOnly,
  });

export const hashCredentialPair = async (
  passwordPort: PasswordPort,
  passwordValue: string,
  pinValue: string,
  errorCode: "BOOTSTRAP_HASH_FAILED" | "COMMISSION_HASH_FAILED",
): Promise<HashedCredentials> => {
  const [passwordHash, pinHash] = await Promise.all([
    passwordPort.hashPassword(passwordValue),
    passwordPort.hashPassword(pinValue),
  ]);
  if (!passwordHash.startsWith("$argon2id$") || !pinHash.startsWith("$argon2id$")) {
    throw new BootstrapError(errorCode);
  }
  return Object.freeze({ passwordHash, pinHash });
};

export const commissionedResult = (
  input: CommissionInput,
  approverStaffId: string,
): CommissionResult =>
  Object.freeze({
    status: "commissioned",
    orgId: input.profile.orgId,
    storeId: input.profile.storeId,
    adminStaffId: input.profile.adminStaffId,
    approverStaffId,
    featureProfileVersion: LOCAL_FEATURE_PROFILE_VERSION,
  });
