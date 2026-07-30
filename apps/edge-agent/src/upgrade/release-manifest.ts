import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

import { compareVersion, isSemVer } from "./version.js";

const SEMVER = /^(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})\.(?:0|[1-9]\d{0,12})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BASE64_ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,179}\.(?:dmg|zip)$/u;
const SIGNING_DOMAIN = "laundry-desk/update-manifest/v1\n";

const ArtifactSchema = z
  .object({
    kind: z.enum(["dmg", "zip"]),
    name: z.string().regex(ARTIFACT_NAME),
    size_bytes: z.number().int().positive().safe(),
    sha256: z.string().regex(SHA256),
  })
  .strict();

const RollbackSchema = z
  .object({
    target_version: z.string().regex(SEMVER),
    artifact_sha256: z.string().regex(SHA256),
    max_compatible_local_schema: z.number().int().nonnegative().safe(),
  })
  .strict();

export const ReleaseManifestAuthoritySchema = z
  .object({
    protocol_version: z.literal(1),
    channel: z.enum(["beta", "stable", "lts"]),
    version: z.string().regex(SEMVER),
    minimum_secure_version: z.string().regex(SEMVER),
    minimum_upgradable_version: z.string().regex(SEMVER),
    contracts_major: z.number().int().nonnegative().safe(),
    local_schema: z.number().int().nonnegative().safe(),
    published_at: z.string().datetime({ offset: true }),
    artifacts: z.array(ArtifactSchema).min(1).max(2),
    rollback: RollbackSchema.nullable(),
  })
  .strict()
  .superRefine((authority, context) => {
    if (
      new Set(authority.artifacts.map((artifact) => artifact.kind)).size !==
      authority.artifacts.length
    ) {
      context.addIssue({ code: "custom", message: "artifact kinds must be unique" });
    }
    if (
      new Set(authority.artifacts.map((artifact) => artifact.name)).size !==
      authority.artifacts.length
    ) {
      context.addIssue({ code: "custom", message: "artifact names must be unique" });
    }
    if (
      isSemVer(authority.version) &&
      isSemVer(authority.minimum_secure_version) &&
      compareVersion(authority.version, authority.minimum_secure_version) < 0
    ) {
      context.addIssue({ code: "custom", message: "release is below its minimum secure version" });
    }
    if (
      isSemVer(authority.version) &&
      isSemVer(authority.minimum_upgradable_version) &&
      compareVersion(authority.minimum_upgradable_version, authority.version) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "minimum upgradable version must precede the release",
      });
    }
    if (
      authority.rollback !== null &&
      isSemVer(authority.rollback.target_version) &&
      isSemVer(authority.version) &&
      compareVersion(authority.rollback.target_version, authority.version) >= 0
    ) {
      context.addIssue({ code: "custom", message: "rollback target must precede the release" });
    }
  });

export const SignedReleaseManifestSchema = z
  .object({
    authority: ReleaseManifestAuthoritySchema,
    signature: z.string().regex(BASE64_ED25519_SIGNATURE),
  })
  .strict();

export type ReleaseManifestAuthority = z.infer<typeof ReleaseManifestAuthoritySchema>;
export type SignedReleaseManifest = z.infer<typeof SignedReleaseManifestSchema>;

export type ReleaseVerificationContext = Readonly<{
  channel: ReleaseManifestAuthority["channel"];
  current_version: string;
  installed_minimum_secure_version: string;
  current_local_schema: number;
  supported_contracts_majors: readonly number[];
}>;

export type ReleaseVerificationResult =
  Readonly<{ ok: true; manifest: SignedReleaseManifest }> | Readonly<{ ok: false; error: string }>;

function freezeAuthority(authority: ReleaseManifestAuthority): ReleaseManifestAuthority {
  const artifacts = authority.artifacts.map((artifact) => {
    const copy = { ...artifact };
    Object.freeze(copy);
    return copy;
  });
  Object.freeze(artifacts);
  const rollback = authority.rollback === null ? null : { ...authority.rollback };
  if (rollback !== null) Object.freeze(rollback);
  return Object.freeze({
    ...authority,
    artifacts,
    rollback,
  });
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function assertEd25519Key(key: KeyObject, purpose: "private" | "public"): void {
  if (key.type !== purpose || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError(`release manifest requires an Ed25519 ${purpose} key`);
  }
}

export function canonicalizeReleaseManifest(authority: unknown): Buffer {
  const parsed = ReleaseManifestAuthoritySchema.parse(authority);
  return Buffer.from(`${SIGNING_DOMAIN}${JSON.stringify(sortJson(parsed))}\n`, "utf8");
}

export function signReleaseManifest(
  authority: unknown,
  privateKey: KeyObject,
): SignedReleaseManifest {
  assertEd25519Key(privateKey, "private");
  const parsed = freezeAuthority(ReleaseManifestAuthoritySchema.parse(authority));
  return Object.freeze({
    authority: parsed,
    signature: sign(null, canonicalizeReleaseManifest(parsed), privateKey).toString("base64"),
  });
}

function verifyPolicy(
  authority: ReleaseManifestAuthority,
  context: ReleaseVerificationContext,
): string | null {
  if (
    !isSemVer(context.current_version) ||
    !isSemVer(context.installed_minimum_secure_version) ||
    !Number.isSafeInteger(context.current_local_schema) ||
    context.current_local_schema < 0 ||
    !Array.isArray(context.supported_contracts_majors) ||
    context.supported_contracts_majors.length === 0 ||
    context.supported_contracts_majors.some((major) => !Number.isSafeInteger(major) || major < 0)
  ) {
    return "UPDATE_CONTEXT_INVALID";
  }
  if (authority.channel !== context.channel) return "UPDATE_CHANNEL_MISMATCH";
  if (compareVersion(authority.version, context.current_version) <= 0) {
    return "UPDATE_VERSION_NOT_NEWER";
  }
  if (compareVersion(context.current_version, authority.minimum_upgradable_version) < 0) {
    return "UPDATE_STEP_REQUIRED";
  }
  if (compareVersion(authority.version, context.installed_minimum_secure_version) < 0) {
    return "UPDATE_BELOW_INSTALLED_SECURITY_FLOOR";
  }
  if (!context.supported_contracts_majors.includes(authority.contracts_major)) {
    return "UPDATE_CONTRACTS_INCOMPATIBLE";
  }
  if (authority.local_schema < context.current_local_schema) {
    return "UPDATE_SCHEMA_DOWNGRADE";
  }
  return null;
}

export function verifyReleaseManifest(
  candidate: unknown,
  publicKey: KeyObject,
  context: ReleaseVerificationContext,
): ReleaseVerificationResult {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    return Object.freeze({ ok: false, error: "UPDATE_PUBLIC_KEY_INVALID" });
  }
  const parsed = SignedReleaseManifestSchema.safeParse(candidate);
  if (!parsed.success) return Object.freeze({ ok: false, error: "UPDATE_MANIFEST_INVALID" });
  const signature = Buffer.from(parsed.data.signature, "base64");
  if (!verify(null, canonicalizeReleaseManifest(parsed.data.authority), publicKey, signature)) {
    return Object.freeze({ ok: false, error: "UPDATE_SIGNATURE_INVALID" });
  }
  const policyError = verifyPolicy(parsed.data.authority, context);
  if (policyError !== null) return Object.freeze({ ok: false, error: policyError });
  return Object.freeze({
    ok: true,
    manifest: Object.freeze({
      authority: freezeAuthority(parsed.data.authority),
      signature: parsed.data.signature,
    }),
  });
}

export function verifyReleaseArtifact(
  authority: ReleaseManifestAuthority,
  artifactName: string,
  bytes: Uint8Array,
): Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }> {
  const artifact = authority.artifacts.find((candidate) => candidate.name === artifactName);
  if (artifact === undefined) return Object.freeze({ ok: false, error: "UPDATE_ARTIFACT_UNKNOWN" });
  if (artifact.size_bytes !== bytes.byteLength) {
    return Object.freeze({ ok: false, error: "UPDATE_ARTIFACT_SIZE_MISMATCH" });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  return digest === artifact.sha256
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, error: "UPDATE_ARTIFACT_HASH_MISMATCH" });
}

export function evaluateReleaseRollback(
  authority: ReleaseManifestAuthority,
  targetVersion: string,
  currentLocalSchema: number,
  installedMinimumSecureVersion: string,
): Readonly<{ allowed: boolean; reason: string }> {
  if (!isSemVer(targetVersion) || !isSemVer(installedMinimumSecureVersion)) {
    return Object.freeze({ allowed: false, reason: "ROLLBACK_CONTEXT_INVALID" });
  }
  if (authority.rollback === null || authority.rollback.target_version !== targetVersion) {
    return Object.freeze({ allowed: false, reason: "ROLLBACK_TARGET_NOT_SIGNED" });
  }
  if (
    compareVersion(targetVersion, authority.minimum_secure_version) < 0 ||
    compareVersion(targetVersion, installedMinimumSecureVersion) < 0
  ) {
    return Object.freeze({ allowed: false, reason: "ROLLBACK_BELOW_SECURITY_FLOOR" });
  }
  if (
    !Number.isSafeInteger(currentLocalSchema) ||
    currentLocalSchema < 0 ||
    currentLocalSchema > authority.rollback.max_compatible_local_schema
  ) {
    return Object.freeze({ allowed: false, reason: "ROLLBACK_SCHEMA_INCOMPATIBLE" });
  }
  return Object.freeze({ allowed: true, reason: "ROLLBACK_SIGNED_AND_COMPATIBLE" });
}

export function verifyReleaseRollbackArtifact(
  authority: ReleaseManifestAuthority,
  bytes: Uint8Array,
): Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }> {
  if (authority.rollback === null) {
    return Object.freeze({ ok: false, error: "ROLLBACK_TARGET_NOT_SIGNED" });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  return digest === authority.rollback.artifact_sha256
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, error: "ROLLBACK_ARTIFACT_HASH_MISMATCH" });
}
