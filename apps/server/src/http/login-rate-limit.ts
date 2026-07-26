import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

const VISIBLE_ASCII_PATTERN = /^[\x21-\x7E]{1,128}$/u;
const IPV4_MAPPED_IPV6_PATTERN = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u;
const MAX_IP_TEXT_LENGTH = 45;
const MAX_POLICY_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_ENTRY_CAPACITY = 100_000;

const DEFAULT_ACCOUNT_POLICY: LoginRateLimitPolicy = Object.freeze({
  maxFailures: 5,
  windowMs: 5 * 60 * 1_000,
  blockMs: 15 * 60 * 1_000,
});
const DEFAULT_IP_POLICY: LoginRateLimitPolicy = Object.freeze({
  maxFailures: 20,
  windowMs: 5 * 60 * 1_000,
  blockMs: 15 * 60 * 1_000,
});
const DEFAULT_MAX_ACCOUNT_ENTRIES = 10_000;
const DEFAULT_MAX_IP_ENTRIES = 1_000;
const DEFAULT_ATTEMPT_LEASE_MS = 60_000;
const ALLOWED_DECISION: LoginRateLimitDecision = Object.freeze({ allowed: true as const });

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PolicyOverrideSchema = z
  .object({
    maxFailures: PositiveSafeIntegerSchema.max(MAX_ENTRY_CAPACITY).optional(),
    windowMs: PositiveSafeIntegerSchema.max(MAX_POLICY_DURATION_MS).optional(),
    blockMs: PositiveSafeIntegerSchema.max(MAX_POLICY_DURATION_MS).optional(),
  })
  .strict();

export type LoginRateLimitClock = Readonly<{
  nowMs: () => number;
}>;

export type LoginRateLimitInput = Readonly<{
  org_code: string;
  store_code: string;
  username: string;
  ip: string;
}>;

export type LoginRateLimitPolicy = Readonly<{
  maxFailures: number;
  windowMs: number;
  blockMs: number;
}>;

export type LoginRateLimiterOptions = Readonly<{
  clock?: LoginRateLimitClock;
  account?: Readonly<Partial<LoginRateLimitPolicy>>;
  ip?: Readonly<Partial<LoginRateLimitPolicy>>;
  maxAccountEntries?: number;
  maxIpEntries?: number;
  attemptLeaseMs?: number;
}>;

export type LoginRateLimitDecision =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type LoginRateLimitReservation = Readonly<{
  succeed: () => void;
  fail: () => LoginRateLimitDecision;
  release: () => void;
}>;

export type LoginRateLimitAttempt =
  | Readonly<{ allowed: true; reservation: LoginRateLimitReservation }>
  | Readonly<{ allowed: false; retryAfterSeconds: number }>;

export type LoginRateLimiter = Readonly<{
  beginAttempt: (input: unknown) => LoginRateLimitAttempt;
}>;

export class LoginRateLimitInputError extends Error {
  readonly code = "INVALID_LOGIN_RATE_LIMIT_INPUT";

  constructor() {
    super("Invalid login rate-limit input");
    this.name = "LoginRateLimitInputError";
  }
}

export class LoginRateLimitReservationError extends Error {
  readonly code = "INVALID_LOGIN_RATE_LIMIT_RESERVATION";

  constructor() {
    super("Login rate-limit reservation is no longer active");
    this.name = "LoginRateLimitReservationError";
  }
}

type FailureBucket = Readonly<{
  failureCount: number;
  windowStartedAtMs: number;
  blockedUntilMs: number | null;
  expiresAtMs: number;
}>;

type ReservationRecord = Readonly<{
  keys: NormalizedKeys;
  expiresAtMs: number;
}>;

type LimiterState = Readonly<{
  accounts: ReadonlyMap<string, FailureBucket>;
  ips: ReadonlyMap<string, FailureBucket>;
  reservations: ReadonlyMap<string, ReservationRecord>;
  accountReservations: ReadonlyMap<string, number>;
  ipReservations: ReadonlyMap<string, number>;
}>;

type NormalizedKeys = Readonly<{
  account: string;
  ip: string;
}>;

type PreparedInput = Readonly<{
  keys: NormalizedKeys;
  nowMs: number;
}>;

type ResolvedOptions = Readonly<{
  clock: LoginRateLimitClock;
  account: LoginRateLimitPolicy;
  ip: LoginRateLimitPolicy;
  maxAccountEntries: number;
  maxIpEntries: number;
  attemptLeaseMs: number;
}>;

type PolicyOverride = Readonly<{
  maxFailures?: number | undefined;
  windowMs?: number | undefined;
  blockMs?: number | undefined;
}>;

const systemClock: LoginRateLimitClock = Object.freeze({ nowMs: () => Date.now() });

const LoginRateLimitInputSchema = z
  .object({
    org_code: z.string().regex(VISIBLE_ASCII_PATTERN),
    store_code: z.string().regex(VISIBLE_ASCII_PATTERN),
    username: z.string().regex(VISIBLE_ASCII_PATTERN),
    ip: z
      .string()
      .min(2)
      .max(MAX_IP_TEXT_LENGTH)
      .refine((value) => isIP(value) !== 0),
  })
  .strict();

function isClock(value: unknown): value is LoginRateLimitClock {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && typeof record.nowMs === "function";
}

const OptionsSchema = z
  .object({
    clock: z.custom<LoginRateLimitClock>(isClock).optional(),
    account: PolicyOverrideSchema.optional(),
    ip: PolicyOverrideSchema.optional(),
    maxAccountEntries: PositiveSafeIntegerSchema.max(MAX_ENTRY_CAPACITY).optional(),
    maxIpEntries: PositiveSafeIntegerSchema.max(MAX_ENTRY_CAPACITY).optional(),
    attemptLeaseMs: PositiveSafeIntegerSchema.max(MAX_POLICY_DURATION_MS).optional(),
  })
  .strict();

function configurationError(): TypeError {
  return new TypeError("Invalid login rate-limit configuration");
}

function resolvePolicy(
  fallback: LoginRateLimitPolicy,
  override: PolicyOverride | undefined,
): LoginRateLimitPolicy {
  return Object.freeze({
    maxFailures: override?.maxFailures ?? fallback.maxFailures,
    windowMs: override?.windowMs ?? fallback.windowMs,
    blockMs: override?.blockMs ?? fallback.blockMs,
  });
}

function resolveOptions(rawOptions: LoginRateLimiterOptions): ResolvedOptions {
  const parsed = OptionsSchema.safeParse(rawOptions);
  if (!parsed.success) throw configurationError();
  return Object.freeze({
    clock: parsed.data.clock ?? systemClock,
    account: resolvePolicy(DEFAULT_ACCOUNT_POLICY, parsed.data.account),
    ip: resolvePolicy(DEFAULT_IP_POLICY, parsed.data.ip),
    maxAccountEntries: parsed.data.maxAccountEntries ?? DEFAULT_MAX_ACCOUNT_ENTRIES,
    maxIpEntries: parsed.data.maxIpEntries ?? DEFAULT_MAX_IP_ENTRIES,
    attemptLeaseMs: parsed.data.attemptLeaseMs ?? DEFAULT_ATTEMPT_LEASE_MS,
  });
}

function mappedIpv4(ip: string): string | null {
  const match = IPV4_MAPPED_IPV6_PATTERN.exec(ip);
  if (match === null) return null;
  const high = Number.parseInt(match[1] ?? "", 16);
  const low = Number.parseInt(match[2] ?? "", 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function normalizeIp(ip: string): string {
  if (isIP(ip) === 4) return ip;
  const hostname = new URL(`http://[${ip}]/`).hostname;
  const normalized = hostname.slice(1, -1).toLowerCase();
  return mappedIpv4(normalized) ?? normalized;
}

function opaqueKey(namespace: "account" | "ip", canonicalValue: string): string {
  return createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(canonicalValue, "utf8")
    .digest("base64url");
}

function normalizeKeys(rawInput: unknown): NormalizedKeys {
  const parsed = LoginRateLimitInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new LoginRateLimitInputError();
  const accountTuple = [
    parsed.data.org_code.toLowerCase(),
    parsed.data.store_code.toLowerCase(),
    parsed.data.username.toLowerCase(),
  ] as const;
  return Object.freeze({
    account: opaqueKey("account", JSON.stringify(accountTuple)),
    ip: opaqueKey("ip", normalizeIp(parsed.data.ip)),
  });
}

function safeAddMs(nowMs: number, durationMs: number): number {
  return durationMs > Number.MAX_SAFE_INTEGER - nowMs
    ? Number.MAX_SAFE_INTEGER
    : nowMs + durationMs;
}

function pruneExpired(
  entries: ReadonlyMap<string, FailureBucket>,
  nowMs: number,
): ReadonlyMap<string, FailureBucket> {
  let changed = false;
  const active = new Map<string, FailureBucket>();
  for (const [key, bucket] of entries) {
    if (bucket.expiresAtMs <= nowMs) {
      changed = true;
    } else {
      active.set(key, bucket);
    }
  }
  return changed ? active : entries;
}

function earliestFailureExpiry(entries: ReadonlyMap<string, FailureBucket>): number {
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const bucket of entries.values()) {
    earliest = Math.min(earliest, bucket.expiresAtMs);
  }
  return earliest;
}

function reservationCount(entries: ReadonlyMap<string, number>, key: string): number {
  return entries.get(key) ?? 0;
}

function occupiedKeyCount(
  failures: ReadonlyMap<string, FailureBucket>,
  reservations: ReadonlyMap<string, number>,
): number {
  if (reservations.size === 0) return failures.size;
  const keys = new Set(failures.keys());
  for (const key of reservations.keys()) keys.add(key);
  return keys.size;
}

function earliestReservationExpiry(
  reservations: ReadonlyMap<string, ReservationRecord>,
  dimension: "account" | "ip",
  key?: string,
): number {
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const reservation of reservations.values()) {
    const reservationKey = reservation.keys[dimension];
    if (key === undefined || reservationKey === key) {
      earliest = Math.min(earliest, reservation.expiresAtMs);
    }
  }
  return earliest;
}

function capacityBlockedUntil(
  failures: ReadonlyMap<string, FailureBucket>,
  reservationCounts: ReadonlyMap<string, number>,
  reservations: ReadonlyMap<string, ReservationRecord>,
  key: string,
  maxEntries: number,
  dimension: "account" | "ip",
): number | null {
  if (failures.has(key) || reservationCounts.has(key)) return null;
  if (occupiedKeyCount(failures, reservationCounts) < maxEntries) return null;
  return Math.min(
    earliestFailureExpiry(failures),
    earliestReservationExpiry(reservations, dimension),
  );
}

function dimensionBlockedUntil(
  failures: ReadonlyMap<string, FailureBucket>,
  reservationCounts: ReadonlyMap<string, number>,
  reservations: ReadonlyMap<string, ReservationRecord>,
  key: string,
  policy: LoginRateLimitPolicy,
  maxEntries: number,
  dimension: "account" | "ip",
): number | null {
  const bucket = failures.get(key);
  if (bucket?.blockedUntilMs !== null && bucket?.blockedUntilMs !== undefined) {
    return bucket.blockedUntilMs;
  }
  const capacityBlock = capacityBlockedUntil(
    failures,
    reservationCounts,
    reservations,
    key,
    maxEntries,
    dimension,
  );
  if (capacityBlock !== null) return capacityBlock;

  const inFlight = reservationCount(reservationCounts, key);
  if ((bucket?.failureCount ?? 0) + inFlight >= policy.maxFailures) {
    return Math.min(
      bucket?.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
      earliestReservationExpiry(reservations, dimension, key),
    );
  }
  return null;
}

function decisionFor(
  unblockTimes: readonly (number | null)[],
  nowMs: number,
): LoginRateLimitDecision {
  const blockedTimes = unblockTimes.filter((value): value is number => value !== null);
  if (blockedTimes.length === 0) return ALLOWED_DECISION;
  const waitMs = Math.max(...blockedTimes) - nowMs;
  return Object.freeze({
    allowed: false as const,
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1_000)),
  });
}

function nextFailureBucket(
  current: FailureBucket | undefined,
  policy: LoginRateLimitPolicy,
  nowMs: number,
): FailureBucket {
  const failureCount = (current?.failureCount ?? 0) + 1;
  const windowStartedAtMs = current?.windowStartedAtMs ?? nowMs;
  if (failureCount >= policy.maxFailures) {
    const blockedUntilMs = safeAddMs(nowMs, policy.blockMs);
    return Object.freeze({
      failureCount,
      windowStartedAtMs,
      blockedUntilMs,
      expiresAtMs: blockedUntilMs,
    });
  }
  return Object.freeze({
    failureCount,
    windowStartedAtMs,
    blockedUntilMs: null,
    expiresAtMs: safeAddMs(windowStartedAtMs, policy.windowMs),
  });
}

function withBucket(
  entries: ReadonlyMap<string, FailureBucket>,
  key: string,
  bucket: FailureBucket,
): ReadonlyMap<string, FailureBucket> {
  const next = new Map(entries);
  next.set(key, bucket);
  return next;
}

function withoutKey<T>(entries: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!entries.has(key)) return entries;
  const next = new Map(entries);
  next.delete(key);
  return next;
}

function incrementCount(
  entries: ReadonlyMap<string, number>,
  key: string,
): ReadonlyMap<string, number> {
  const next = new Map(entries);
  next.set(key, (entries.get(key) ?? 0) + 1);
  return next;
}

function decrementCount(
  entries: ReadonlyMap<string, number>,
  key: string,
): ReadonlyMap<string, number> {
  const current = entries.get(key);
  if (current === undefined) return entries;
  if (current === 1) return withoutKey(entries, key);
  const next = new Map(entries);
  next.set(key, current - 1);
  return next;
}

function activeReservationState(state: LimiterState, nowMs: number): LimiterState {
  let foundExpired = false;
  const reservations = new Map<string, ReservationRecord>();
  const accountReservations = new Map<string, number>();
  const ipReservations = new Map<string, number>();
  for (const [id, reservation] of state.reservations) {
    if (reservation.expiresAtMs <= nowMs) {
      foundExpired = true;
      continue;
    }
    reservations.set(id, reservation);
    accountReservations.set(
      reservation.keys.account,
      (accountReservations.get(reservation.keys.account) ?? 0) + 1,
    );
    ipReservations.set(reservation.keys.ip, (ipReservations.get(reservation.keys.ip) ?? 0) + 1);
  }
  if (!foundExpired) return state;
  return Object.freeze({
    ...state,
    reservations,
    accountReservations,
    ipReservations,
  });
}

function pruneState(state: LimiterState, nowMs: number): LimiterState {
  const active = activeReservationState(state, nowMs);
  return Object.freeze({
    ...active,
    accounts: pruneExpired(active.accounts, nowMs),
    ips: pruneExpired(active.ips, nowMs),
  });
}

function stateDecision(
  state: LimiterState,
  keys: NormalizedKeys,
  nowMs: number,
  options: ResolvedOptions,
): LoginRateLimitDecision {
  return decisionFor(
    [
      dimensionBlockedUntil(
        state.accounts,
        state.accountReservations,
        state.reservations,
        keys.account,
        options.account,
        options.maxAccountEntries,
        "account",
      ),
      dimensionBlockedUntil(
        state.ips,
        state.ipReservations,
        state.reservations,
        keys.ip,
        options.ip,
        options.maxIpEntries,
        "ip",
      ),
    ],
    nowMs,
  );
}

function stateAfterFailure(
  state: LimiterState,
  keys: NormalizedKeys,
  nowMs: number,
  options: ResolvedOptions,
): LimiterState {
  return Object.freeze({
    ...state,
    accounts: withBucket(
      state.accounts,
      keys.account,
      nextFailureBucket(state.accounts.get(keys.account), options.account, nowMs),
    ),
    ips: withBucket(
      state.ips,
      keys.ip,
      nextFailureBucket(state.ips.get(keys.ip), options.ip, nowMs),
    ),
  });
}

function stateWithReservation(
  state: LimiterState,
  id: string,
  reservation: ReservationRecord,
): LimiterState {
  const reservations = new Map(state.reservations);
  reservations.set(id, reservation);
  return Object.freeze({
    ...state,
    reservations,
    accountReservations: incrementCount(state.accountReservations, reservation.keys.account),
    ipReservations: incrementCount(state.ipReservations, reservation.keys.ip),
  });
}

function stateWithoutReservation(
  state: LimiterState,
  id: string,
  reservation: ReservationRecord,
): LimiterState {
  return Object.freeze({
    ...state,
    reservations: withoutKey(state.reservations, id),
    accountReservations: decrementCount(state.accountReservations, reservation.keys.account),
    ipReservations: decrementCount(state.ipReservations, reservation.keys.ip),
  });
}

function createNowReader(clock: LoginRateLimitClock): () => number {
  let lastNowMs: number | null = null;
  return (): number => {
    const nowMs = clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || (lastNowMs !== null && nowMs < lastNowMs)) {
      throw new TypeError("Invalid login rate-limit clock");
    }
    lastNowMs = nowMs;
    return nowMs;
  };
}

export function createLoginRateLimiter(
  options: LoginRateLimiterOptions = Object.freeze({}),
): LoginRateLimiter {
  const resolved = resolveOptions(options);
  const readNowMs = createNowReader(resolved.clock);
  let state: LimiterState = Object.freeze({
    accounts: new Map<string, FailureBucket>(),
    ips: new Map<string, FailureBucket>(),
    reservations: new Map<string, ReservationRecord>(),
    accountReservations: new Map<string, number>(),
    ipReservations: new Map<string, number>(),
  });

  const prepare = (input: unknown): PreparedInput => {
    const keys = normalizeKeys(input);
    const nowMs = readNowMs();
    state = pruneState(state, nowMs);
    return Object.freeze({ keys, nowMs });
  };

  const requireReservation = (
    id: string,
  ): Readonly<{ reservation: ReservationRecord; nowMs: number }> => {
    const nowMs = readNowMs();
    state = pruneState(state, nowMs);
    const reservation = state.reservations.get(id);
    if (reservation === undefined) throw new LoginRateLimitReservationError();
    return Object.freeze({ reservation, nowMs });
  };

  const finalizeSuccess = (id: string): void => {
    const { reservation } = requireReservation(id);
    const released = stateWithoutReservation(state, id, reservation);
    state = Object.freeze({
      ...released,
      accounts: withoutKey(released.accounts, reservation.keys.account),
    });
  };

  const finalizeFailure = (id: string): LoginRateLimitDecision => {
    const { reservation, nowMs } = requireReservation(id);
    state = stateAfterFailure(
      stateWithoutReservation(state, id, reservation),
      reservation.keys,
      nowMs,
      resolved,
    );
    return stateDecision(state, reservation.keys, nowMs, resolved);
  };

  const release = (id: string): void => {
    const { reservation } = requireReservation(id);
    state = stateWithoutReservation(state, id, reservation);
  };

  const createReservation = (id: string): LoginRateLimitReservation =>
    Object.freeze({
      succeed: (): void => finalizeSuccess(id),
      fail: (): LoginRateLimitDecision => finalizeFailure(id),
      release: (): void => release(id),
    });

  const beginAttempt = (input: unknown): LoginRateLimitAttempt => {
    const { keys, nowMs } = prepare(input);
    const before = stateDecision(state, keys, nowMs, resolved);
    if (!before.allowed) return before;

    const id = randomUUID();
    state = stateWithReservation(
      state,
      id,
      Object.freeze({
        keys,
        expiresAtMs: safeAddMs(nowMs, resolved.attemptLeaseMs),
      }),
    );
    return Object.freeze({
      allowed: true as const,
      reservation: createReservation(id),
    });
  };

  return Object.freeze({ beginAttempt });
}
