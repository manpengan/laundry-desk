import {
  DesktopQueryExecuteInputSchema,
  DesktopQueryExecuteResultSchema,
  DesktopSessionViewSchema,
  SignedOfflineGrantSchema,
  canonicalizeForSignatureVerification,
  createOfflineGrantRegistrySnapshot,
  parseServerSignatureOfflineGrantCandidate,
  type DesktopQueryExecuteResult,
  type DesktopSessionView,
} from "@laundry/contracts";
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";

import type { AuthorityTrustStore } from "../pairing/authority-trust.js";
import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import type { VerifiedOfflineReadAuthority } from "./read-authority.js";
import { MAX_CACHE_PLAINTEXT_BYTES, OfflineReadCacheFile } from "./read-cache-file.js";

export const OFFLINE_READ_QUERY_NAMES = Object.freeze([
  "catalog.items.get",
  "catalog.items.list",
  "customer.get",
  "customer.search",
  "fulfillment.workbench",
  "order.get",
  "order.list",
  "order.lookup",
] as const);

const queryNames = new Set<string>(OFFLINE_READ_QUERY_NAMES);
const MAX_ENTRY_BYTES = 320 * 1_024;
const MAX_ENTRIES = 128;

const CacheEntrySchema = z.strictObject({
  query_key: z.string().regex(/^[a-f0-9]{64}$/u),
  canonical_request: z
    .string()
    .min(2)
    .max(256 * 1_024),
  result: DesktopQueryExecuteResultSchema,
  cached_at_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const CacheStateSchema = z.strictObject({
  version: z.literal(1),
  session_view: DesktopSessionViewSchema,
  server_public_key_spki: z.base64(),
  offline_grant: SignedOfflineGrantSchema,
  last_seen_wall_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(CacheEntrySchema).max(MAX_ENTRIES),
});

type CacheState = z.output<typeof CacheStateSchema>;
type CacheEntry = z.output<typeof CacheEntrySchema>;

export type OfflineReadResume = Readonly<{
  sessionView: DesktopSessionView;
  cachedQueryCount: number;
  grantNotAfter: string;
}>;

export type OfflineReadCacheOptions = Readonly<{
  rootPath: string;
  safeStorage: SafeStorageSurface;
  authorityTrust: AuthorityTrustStore;
  now?: () => Date;
}>;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`)
    .join(",")}}`;
}

function sameSession(left: DesktopSessionView, right: DesktopSessionView): boolean {
  const a = left.session;
  const b = right.session;
  return (
    a.session_id === b.session_id &&
    a.session_version === b.session_version &&
    a.org_id === b.org_id &&
    a.store_id === b.store_id &&
    a.staff_id === b.staff_id &&
    a.device_id === b.device_id &&
    a.permission_version === b.permission_version
  );
}

function queryIdentity(input: unknown): Readonly<{ canonical: string; key: string }> {
  const canonical = canonicalJson(input);
  return Object.freeze({
    canonical,
    key: createHash("sha256").update(canonical, "utf8").digest("hex"),
  });
}

export class OfflineReadCache {
  private readonly file: OfflineReadCacheFile;
  private readonly authorityTrust: AuthorityTrustStore;
  private readonly now: () => Date;

  constructor(options: OfflineReadCacheOptions) {
    this.file = new OfflineReadCacheFile(options.rootPath, options.safeStorage);
    this.authorityTrust = options.authorityTrust;
    this.now = options.now ?? (() => new Date());
  }

  bind(sessionInput: DesktopSessionView, authority: VerifiedOfflineReadAuthority): void {
    const session = DesktopSessionViewSchema.parse(sessionInput);
    const nowMs = this.readNow();
    if (!this.verifyAuthority(session, authority, nowMs)) {
      throw new Error("Offline read authority is invalid");
    }
    const previous = this.tryReadState();
    if (
      previous !== null &&
      sameSession(previous.session_view, session) &&
      nowMs < previous.last_seen_wall_ms
    ) {
      throw new Error("Offline read cache detected wall-clock rollback");
    }
    const entries =
      previous !== null && sameSession(previous.session_view, session)
        ? previous.entries
        : Object.freeze([]);
    this.writeState({
      version: 1,
      session_view: session,
      server_public_key_spki: authority.serverPublicKeySpki,
      offline_grant: authority.offlineGrant,
      last_seen_wall_ms: Math.max(previous?.last_seen_wall_ms ?? 0, nowMs),
      entries,
    });
  }

  async put(
    sessionInput: DesktopSessionView,
    input: unknown,
    resultInput: unknown,
  ): Promise<boolean> {
    const parsedInput = await DesktopQueryExecuteInputSchema.safeParseAsync(input);
    const parsedResult = DesktopQueryExecuteResultSchema.safeParse(resultInput);
    if (
      !parsedInput.success ||
      !parsedResult.success ||
      !parsedResult.data.ok ||
      !queryNames.has(parsedInput.data.name)
    ) {
      return false;
    }
    const session = DesktopSessionViewSchema.parse(sessionInput);
    const state = this.readUsableState(session);
    if (state === null) return false;
    const identity = queryIdentity(parsedInput.data);
    const entry = CacheEntrySchema.parse({
      query_key: identity.key,
      canonical_request: identity.canonical,
      result: parsedResult.data,
      cached_at_ms: this.readNow(),
    });
    if (jsonBytes(entry) > MAX_ENTRY_BYTES) return false;
    const retained = state.entries.filter((candidate) => candidate.query_key !== identity.key);
    const entries = this.fitEntries([...retained, entry], state);
    if (!entries.some((candidate) => candidate.query_key === identity.key)) return false;
    this.writeState({ ...state, last_seen_wall_ms: entry.cached_at_ms, entries });
    return true;
  }

  async get(
    sessionInput: DesktopSessionView,
    input: unknown,
  ): Promise<DesktopQueryExecuteResult | null> {
    const parsedInput = await DesktopQueryExecuteInputSchema.safeParseAsync(input);
    if (!parsedInput.success || !queryNames.has(parsedInput.data.name)) return null;
    const session = DesktopSessionViewSchema.parse(sessionInput);
    const state = this.readUsableState(session);
    if (state === null) return null;
    const identity = queryIdentity(parsedInput.data);
    const entry = state.entries.find(
      (candidate) =>
        candidate.query_key === identity.key && candidate.canonical_request === identity.canonical,
    );
    if (entry === undefined) return null;
    const nowMs = this.readNow();
    this.writeState({ ...state, last_seen_wall_ms: nowMs });
    return entry.result;
  }

  resume(): OfflineReadResume | null {
    const state = this.tryReadState();
    if (state === null || state.entries.length === 0) return null;
    const nowMs = this.readNowOrNull();
    if (nowMs === null || !this.isUsable(state, state.session_view, nowMs)) return null;
    try {
      this.writeState({ ...state, last_seen_wall_ms: nowMs });
    } catch {
      return null;
    }
    return Object.freeze({
      sessionView: state.session_view,
      cachedQueryCount: state.entries.length,
      grantNotAfter: state.offline_grant.payload.not_after,
    });
  }

  clear(): void {
    this.file.clear();
  }

  private fitEntries(entries: readonly CacheEntry[], state: CacheState): readonly CacheEntry[] {
    const ordered = [...entries].sort((a, b) => a.cached_at_ms - b.cached_at_ms);
    while (
      ordered.length > 0 &&
      jsonBytes({ ...state, entries: ordered }) > MAX_CACHE_PLAINTEXT_BYTES
    ) {
      ordered.shift();
    }
    return Object.freeze(ordered);
  }

  private readUsableState(session: DesktopSessionView): CacheState | null {
    const state = this.tryReadState();
    const nowMs = this.readNowOrNull();
    return state !== null && nowMs !== null && this.isUsable(state, session, nowMs) ? state : null;
  }

  private isUsable(state: CacheState, session: DesktopSessionView, nowMs: number): boolean {
    return (
      sameSession(state.session_view, session) &&
      nowMs >= state.last_seen_wall_ms &&
      this.verifyAuthority(
        session,
        {
          serverPublicKeySpki: state.server_public_key_spki,
          offlineGrant: state.offline_grant,
        },
        nowMs,
      )
    );
  }

  private verifyAuthority(
    session: DesktopSessionView,
    authority: VerifiedOfflineReadAuthority,
    nowMs: number,
  ): boolean {
    try {
      const candidate = parseServerSignatureOfflineGrantCandidate(
        authority.offlineGrant,
        createOfflineGrantRegistrySnapshot(),
      );
      const spki = Buffer.from(authority.serverPublicKeySpki, "base64");
      if (spki.toString("base64") !== authority.serverPublicKeySpki) return false;
      const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
      const payload = candidate.payload;
      return (
        publicKey.asymmetricKeyType === "ed25519" &&
        verify(
          null,
          canonicalizeForSignatureVerification(candidate),
          publicKey,
          Buffer.from(candidate.sig, "base64url"),
        ) &&
        this.authorityTrust.accept(publicKey) &&
        payload.org_id === session.session.org_id &&
        payload.store_id === session.session.store_id &&
        payload.staff_id === session.session.staff_id &&
        payload.device_id === session.session.device_id &&
        payload.permission_version === session.session.permission_version &&
        nowMs >= Date.parse(payload.issued_at) &&
        nowMs < Date.parse(payload.not_after)
      );
    } catch {
      return false;
    }
  }

  private readNow(): number {
    const nowMs = this.now().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid wall clock");
    return nowMs;
  }

  private readNowOrNull(): number | null {
    try {
      return this.readNow();
    } catch {
      return null;
    }
  }

  private tryReadState(): CacheState | null {
    try {
      return this.readState();
    } catch {
      return null;
    }
  }

  private readState(): CacheState | null {
    const value = this.file.read();
    return value === null ? null : CacheStateSchema.parse(value);
  }

  private writeState(stateInput: unknown): void {
    const state = CacheStateSchema.parse(stateInput);
    this.file.write(state);
  }
}
