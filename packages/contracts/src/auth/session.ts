import { z } from "zod";

import type { EdgeReplaySource } from "./edge-ingress.js";
import { snapshotPlainData } from "./plain-data.js";
import {
  hasBrowserSessionSourceProvenance,
  hasEdgeReplaySourceProvenance,
} from "./source-registry.js";

export const ACCESS_TOKEN_TTL_SECONDS = 900;

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const EpochSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const AuthenticationMethodSchema = z.enum(["password", "pin", "refresh"]);
export const BrowserCommandViaSchema = z.enum(["ui", "ai", "automation"]);

export const AccessTokenClaimsSchema = z
  .strictObject({
    session_id: z.uuid(),
    session_version: PositiveSafeIntegerSchema,
    org_id: z.uuid(),
    store_id: z.uuid(),
    staff_id: z.uuid(),
    device_id: z.uuid(),
    permission_version: PositiveSafeIntegerSchema,
    authentication_method: AuthenticationMethodSchema,
    iat: EpochSecondsSchema,
    exp: EpochSecondsSchema,
  })
  .superRefine((claims, context) => {
    if (claims.exp - claims.iat !== ACCESS_TOKEN_TTL_SECONDS) {
      context.addIssue({
        code: "custom",
        message: `Access token lifetime must be exactly ${ACCESS_TOKEN_TTL_SECONDS} seconds`,
        path: ["exp"],
      });
    }
  });

const SessionRecordFields = {
  session_id: z.uuid(),
  session_version: PositiveSafeIntegerSchema,
  org_id: z.uuid(),
  store_id: z.uuid(),
  staff_id: z.uuid(),
  device_id: z.uuid(),
  permission_version: PositiveSafeIntegerSchema,
  authentication_method: AuthenticationMethodSchema,
};

export const ServerSessionRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("active"), ...SessionRecordFields }),
  z.strictObject({ status: z.literal("revoked"), ...SessionRecordFields }),
]);

export type AccessTokenClaims = Readonly<z.output<typeof AccessTokenClaimsSchema>>;
export type ServerSessionRecord = Readonly<z.output<typeof ServerSessionRecordSchema>>;
export type BrowserCommandVia = z.output<typeof BrowserCommandViaSchema>;

export type AuthenticatedActor = Readonly<{
  staff_id: string;
  device_id: string;
  via: BrowserCommandVia | "edge_replay";
}>;

export type AuthenticatedTenant = Readonly<{
  org_id: string;
  store_id: string;
}>;

declare const BROWSER_SESSION_SOURCE_BRAND: unique symbol;

export type BrowserSessionSource = Readonly<{
  kind: "browser_session";
  session_id: string;
  session_version: number;
  permission_version: number;
  authentication_method: z.output<typeof AuthenticationMethodSchema>;
  actor: Readonly<AuthenticatedActor & { via: BrowserCommandVia }>;
  tenant: AuthenticatedTenant;
  [BROWSER_SESSION_SOURCE_BRAND]: true;
}>;

export type AuthenticatedExecutionSource = BrowserSessionSource | EdgeReplaySource;

/** Strict claims parser; the descriptor snapshot prevents schema traversal of caller objects. */
export const parseAccessTokenClaims = (input: unknown): AccessTokenClaims =>
  Object.freeze(AccessTokenClaimsSchema.parse(snapshotPlainData(input, "access claims")));

export const isBrowserSessionSource = (value: unknown): value is BrowserSessionSource =>
  hasBrowserSessionSourceProvenance(value);

export const isEdgeReplaySource = (value: unknown): value is EdgeReplaySource =>
  hasEdgeReplaySourceProvenance(value);

export const isAuthenticatedExecutionSource = (
  value: unknown,
): value is AuthenticatedExecutionSource =>
  isBrowserSessionSource(value) || isEdgeReplaySource(value);
