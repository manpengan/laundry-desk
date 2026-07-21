import { z } from "zod";

import { snapshotPlainData } from "./plain-data.js";

export const REFRESH_TOKEN_TTL_SECONDS = 1_209_600;

export const REFRESH_COOKIE_DESCRIPTOR = Object.freeze({
  name: "__Host-laundry_refresh" as const,
  secure: true as const,
  http_only: true as const,
  same_site: "strict" as const,
  path: "/" as const,
  max_age_seconds: REFRESH_TOKEN_TTL_SECONDS,
});

export const REFRESH_COOKIE_CLEAR_DESCRIPTOR = Object.freeze({
  ...REFRESH_COOKIE_DESCRIPTOR,
  max_age_seconds: 0 as const,
});

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IncrementableSessionVersionSchema = PositiveSafeIntegerSchema.max(
  Number.MAX_SAFE_INTEGER - 1,
);
const EpochSecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const RefreshTokenFields = {
  token_id: z.uuid(),
  family_id: z.uuid(),
  session_id: z.uuid(),
  expires_at: EpochSecondsSchema,
};

export const RefreshTokenRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("active"), ...RefreshTokenFields }),
  z.strictObject({
    status: z.literal("rotated"),
    ...RefreshTokenFields,
    replacement_token_id: z.uuid(),
  }),
  z.strictObject({ status: z.literal("revoked"), ...RefreshTokenFields }),
  z.strictObject({ status: z.literal("unknown") }),
]);

const RefreshFamilyFields = {
  family_id: z.uuid(),
  session_id: z.uuid(),
};

export const RefreshFamilyRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("active"), ...RefreshFamilyFields }),
  z.strictObject({ status: z.literal("revoked"), ...RefreshFamilyFields }),
]);

const RefreshSessionStateSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("active"),
    session_id: z.uuid(),
    session_version: PositiveSafeIntegerSchema,
  }),
  z.strictObject({
    status: z.literal("revoked"),
    session_id: z.uuid(),
    session_version: PositiveSafeIntegerSchema,
  }),
]);

export type RefreshTokenRecord = Readonly<z.output<typeof RefreshTokenRecordSchema>>;
export type RefreshFamilyRecord = Readonly<z.output<typeof RefreshFamilyRecordSchema>>;

export type RefreshRevocationCause =
  "logout" | "refresh_reuse" | "pin_switch" | "admin_revoke" | "credential_change";

export type RefreshMutationPlan =
  | Readonly<{
      kind: "rotate";
      compare: Readonly<{
        token_id: string;
        token_status: "active";
        family_id: string;
        family_status: "active";
        session_id: string;
        session_version: number;
      }>;
      effects: Readonly<{
        replacement_token_id: string;
        mark_token_rotated: true;
        revoke_session: false;
      }>;
    }>
  | Readonly<{
      kind: "revoke";
      cause: RefreshRevocationCause;
      revoke_family: true;
      revoke_session: true;
      next_session_version: number;
    }>
  | Readonly<{ kind: "reject"; public_code: "AUTHENTICATION_FAILED" }>;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

const deepFreeze = <T>(value: T): DeepReadonly<T> => {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => deepFreeze(entry))) as DeepReadonly<T>;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)]);
    return Object.freeze(Object.fromEntries(entries)) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
};

const parseSnapshot = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> => schema.parse(snapshotPlainData(input, label));

const REJECT_PLAN = Object.freeze({
  kind: "reject" as const,
  public_code: "AUTHENTICATION_FAILED" as const,
});

const createRevocationPlan = (
  cause: RefreshRevocationCause,
  sessionVersion: number,
): Extract<RefreshMutationPlan, { kind: "revoke" }> =>
  Object.freeze({
    kind: "revoke",
    cause,
    revoke_family: true,
    revoke_session: true,
    next_session_version: IncrementableSessionVersionSchema.parse(sessionVersion) + 1,
  });

const RefreshMutationInputSchema = z.strictObject({
  token: RefreshTokenRecordSchema,
  family: RefreshFamilyRecordSchema.nullable(),
  session: RefreshSessionStateSchema.nullable(),
  now_epoch_seconds: EpochSecondsSchema,
  replacement_token_id: z.uuid(),
});

const hasCurrentBindings = (
  token: Exclude<RefreshTokenRecord, { status: "unknown" }>,
  family: RefreshFamilyRecord,
  session: z.output<typeof RefreshSessionStateSchema>,
): boolean =>
  family.status === "active" &&
  session.status === "active" &&
  token.family_id === family.family_id &&
  token.session_id === family.session_id &&
  family.session_id === session.session_id;

/** Produces a persistence compare/effects plan without performing a repository mutation. */
export const planRefreshMutation = (input: unknown): RefreshMutationPlan => {
  const facts = parseSnapshot(RefreshMutationInputSchema, input, "refresh mutation facts");
  if (facts.token.status === "unknown" || facts.family === null || facts.session === null) {
    return REJECT_PLAN;
  }
  if (!hasCurrentBindings(facts.token, facts.family, facts.session)) return REJECT_PLAN;
  if (facts.token.status === "rotated") {
    return createRevocationPlan("refresh_reuse", facts.session.session_version);
  }
  if (
    facts.token.status !== "active" ||
    facts.token.expires_at <= facts.now_epoch_seconds ||
    facts.replacement_token_id === facts.token.token_id
  ) {
    return REJECT_PLAN;
  }

  return deepFreeze({
    kind: "rotate" as const,
    compare: {
      token_id: facts.token.token_id,
      token_status: "active" as const,
      family_id: facts.family.family_id,
      family_status: "active" as const,
      session_id: facts.session.session_id,
      session_version: facts.session.session_version,
    },
    effects: {
      replacement_token_id: facts.replacement_token_id,
      mark_token_rotated: true as const,
      revoke_session: false as const,
    },
  });
};

const RefreshRevocationInputSchema = z.strictObject({
  cause: z.enum(["logout", "refresh_reuse", "pin_switch", "admin_revoke", "credential_change"]),
  session_version: IncrementableSessionVersionSchema,
});

/** Produces the shared family/session cascade for every A5 revocation cause. */
export const planRefreshRevocation = (input: unknown): RefreshMutationPlan => {
  const facts = parseSnapshot(RefreshRevocationInputSchema, input, "refresh revocation facts");
  return createRevocationPlan(facts.cause, facts.session_version);
};

export type RefreshCasCommitDisposition =
  | Readonly<{ kind: "committed" }>
  | Readonly<{
      kind: "stale";
      action: "reload_and_reject";
      public_code: "AUTHENTICATION_FAILED";
    }>;

const RefreshCasCommitInputSchema = z.strictObject({
  matched_rows: z.union([z.literal(0), z.literal(1)]),
});

/** Classifies C6's database CAS result; only exactly one matched row is a successful rotation. */
export const classifyRefreshCasCommit = (input: unknown): RefreshCasCommitDisposition => {
  const { matched_rows: matchedRows } = parseSnapshot(
    RefreshCasCommitInputSchema,
    input,
    "refresh CAS result",
  );
  return matchedRows === 1
    ? Object.freeze({ kind: "committed" })
    : Object.freeze({
        kind: "stale",
        action: "reload_and_reject",
        public_code: "AUTHENTICATION_FAILED",
      });
};

const SessionFamilyReplacementInputSchema = z
  .strictObject({
    cause: z.enum(["login", "pin_switch"]),
    previous_session_id: z.uuid(),
    previous_family_id: z.uuid(),
    previous_session_version: IncrementableSessionVersionSchema,
    next_session_id: z.uuid(),
    next_family_id: z.uuid(),
  })
  .superRefine((input, context) => {
    if (input.previous_session_id === input.next_session_id) {
      context.addIssue({ code: "custom", message: "Replacement session id must be new" });
    }
    if (input.previous_family_id === input.next_family_id) {
      context.addIssue({ code: "custom", message: "Replacement family id must be new" });
    }
  });

export type SessionFamilyReplacementPlan = DeepReadonly<{
  kind: "replace_session_family";
  cause: "login" | "pin_switch";
  steps: readonly [
    {
      order: 1;
      action: "revoke_previous";
      session_id: string;
      family_id: string;
      next_session_version: number;
    },
    {
      order: 2;
      action: "create_replacement";
      session_id: string;
      family_id: string;
    },
  ];
}>;

/** Freezes the revoke-before-create ordering required for login and PIN switch replacement. */
export const planSessionFamilyReplacement = (input: unknown): SessionFamilyReplacementPlan => {
  const facts = parseSnapshot(
    SessionFamilyReplacementInputSchema,
    input,
    "session family replacement facts",
  );
  return deepFreeze({
    kind: "replace_session_family" as const,
    cause: facts.cause,
    steps: [
      {
        order: 1 as const,
        action: "revoke_previous" as const,
        session_id: facts.previous_session_id,
        family_id: facts.previous_family_id,
        next_session_version: facts.previous_session_version + 1,
      },
      {
        order: 2 as const,
        action: "create_replacement" as const,
        session_id: facts.next_session_id,
        family_id: facts.next_family_id,
      },
    ] as const,
  });
};

export type LogoutStorageDisposition =
  | Readonly<{ kind: "revoked"; storage_idempotent: true }>
  | Readonly<{ kind: "no_op"; storage_idempotent: true }>;

const LogoutStorageMutationInputSchema = z.strictObject({
  matched_session_rows: z.union([z.literal(0), z.literal(1)]),
  matched_family_rows: z.union([z.literal(0), z.literal(1)]),
});

/** Keeps the idempotent storage result separate from lifecycle HTTP authentication semantics. */
export const classifyLogoutStorageMutation = (input: unknown): LogoutStorageDisposition => {
  const facts = parseSnapshot(LogoutStorageMutationInputSchema, input, "logout storage result");
  if (facts.matched_session_rows !== facts.matched_family_rows) {
    throw new TypeError("Logout must atomically revoke both session and family");
  }
  return facts.matched_session_rows === 1
    ? Object.freeze({ kind: "revoked", storage_idempotent: true })
    : Object.freeze({ kind: "no_op", storage_idempotent: true });
};

export type LogoutHttpCredentialDisposition =
  | Readonly<{ kind: "proceed" }>
  | Readonly<{
      kind: "reject";
      public_code: "AUTHENTICATION_FAILED";
      http_status: 401;
      client_logged_out: true;
    }>;

const LogoutHttpCredentialInputSchema = z.strictObject({ refresh_cookie_present: z.boolean() });

/** A repeated request without its cleared credential may return 401 while the client stays logged out. */
export const classifyLogoutHttpCredential = (input: unknown): LogoutHttpCredentialDisposition => {
  const facts = parseSnapshot(
    LogoutHttpCredentialInputSchema,
    input,
    "logout HTTP credential facts",
  );
  return facts.refresh_cookie_present
    ? Object.freeze({ kind: "proceed" })
    : Object.freeze({
        kind: "reject",
        public_code: "AUTHENTICATION_FAILED",
        http_status: 401,
        client_logged_out: true,
      });
};
