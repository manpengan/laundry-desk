import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { SqlClient, TenantContext } from "../db/types.js";
import { AiProviderNameSchema, type AiProviderName } from "./providers/types.js";

const CREDENTIAL_SCHEMA_VERSION = "1";
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

const Base64Schema = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const CredentialIdSchema = z.uuid();
const KeyVersionSchema = z.string().min(1).max(64);

export const AiCredentialStatusSchema = z.enum(["unverified", "verified", "invalid"]);
export type AiCredentialStatus = z.output<typeof AiCredentialStatusSchema>;

export const EncryptedAiCredentialSchema = z
  .object({
    credential_id: CredentialIdSchema,
    org_id: z.uuid(),
    provider: AiProviderNameSchema,
    key_ciphertext: Base64Schema,
    key_nonce: Base64Schema,
    key_tag: Base64Schema,
    wrapped_dek: Base64Schema,
    dek_wrap_nonce: Base64Schema,
    dek_wrap_tag: Base64Schema,
    key_version: KeyVersionSchema,
    last4: z.string().length(4),
    status: AiCredentialStatusSchema,
  })
  .strict();
export type EncryptedAiCredential = z.output<typeof EncryptedAiCredentialSchema>;

export type AiCredentialMetadata = Readonly<{
  credential_id: string;
  provider: AiProviderName;
  last4: string;
  key_version: string;
  status: AiCredentialStatus;
}>;

export type KekProvider = Readonly<{
  active: () => Readonly<{ key_version: string; key: Uint8Array }>;
  get: (keyVersion: string) => Uint8Array | null;
}>;

export type AiCredentialStore = Readonly<{
  save: (tenant: TenantContext, credential: EncryptedAiCredential) => Promise<void>;
  get: (tenant: TenantContext, credentialId: string) => Promise<EncryptedAiCredential | null>;
  list: (tenant: TenantContext) => Promise<readonly AiCredentialMetadata[]>;
  setStatus: (
    tenant: TenantContext,
    credentialId: string,
    status: AiCredentialStatus,
  ) => Promise<void>;
}>;

export type TenantSqlRunner = <T>(
  tenant: TenantContext,
  operation: (client: SqlClient) => Promise<T>,
) => Promise<T>;

type EncryptInput = Readonly<{
  apiKey: string;
  credentialId: string;
  orgId: string;
  provider: AiProviderName;
  kekProvider: KekProvider;
}>;

type DecryptInput = Readonly<{
  credential: EncryptedAiCredential;
  orgId: string;
  provider: AiProviderName;
  kekProvider: KekProvider;
}>;

type CipherParts = Readonly<{ ciphertext: Buffer; nonce: Buffer; tag: Buffer }>;

const toBase64 = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const fromBase64 = (value: string): Buffer => Buffer.from(Base64Schema.parse(value), "base64url");

function ensureAesKey(key: Uint8Array): Buffer {
  const copy = Buffer.from(key);
  if (copy.byteLength !== AES_KEY_BYTES) {
    throw new TypeError("KEK must be exactly 32 bytes");
  }
  return copy;
}

function credentialAad(orgId: string, provider: AiProviderName, credentialId: string): Buffer {
  return Buffer.from(`${orgId}|${provider}|${credentialId}|${CREDENTIAL_SCHEMA_VERSION}`, "utf8");
}

function dekWrapAad(orgId: string, provider: AiProviderName, credentialId: string): Buffer {
  return Buffer.from(
    `dek|${credentialAad(orgId, provider, credentialId).toString("utf8")}`,
    "utf8",
  );
}

function encryptAesGcm(plaintext: Uint8Array, key: Uint8Array, aad: Buffer): CipherParts {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", ensureAesKey(key), nonce, {
    authTagLength: GCM_TAG_BYTES,
  });
  cipher.setAAD(aad);
  return Object.freeze({
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]),
    nonce,
    tag: cipher.getAuthTag(),
  });
}

function decryptAesGcm(parts: CipherParts, key: Uint8Array, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv("aes-256-gcm", ensureAesKey(key), parts.nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(parts.tag);
    return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
  } catch {
    throw new Error("Credential authentication failed");
  }
}

function encodeParts(
  parts: CipherParts,
): Readonly<{ ciphertext: string; nonce: string; tag: string }> {
  return Object.freeze({
    ciphertext: toBase64(parts.ciphertext),
    nonce: toBase64(parts.nonce),
    tag: toBase64(parts.tag),
  });
}

function decodeParts(ciphertext: string, nonce: string, tag: string): CipherParts {
  return Object.freeze({
    ciphertext: fromBase64(ciphertext),
    nonce: fromBase64(nonce),
    tag: fromBase64(tag),
  });
}

export function createStaticKekProvider(keyVersion: string, key: Uint8Array): KekProvider {
  const version = KeyVersionSchema.parse(keyVersion);
  const keyCopy = ensureAesKey(key);
  return Object.freeze({
    active: () => Object.freeze({ key_version: version, key: Buffer.from(keyCopy) }),
    get: (requestedVersion: string) => (requestedVersion === version ? Buffer.from(keyCopy) : null),
  });
}

/** Encrypt one provider API key; no plaintext exists on the returned record. */
export function encryptApiKey(input: EncryptInput): EncryptedAiCredential {
  const provider = AiProviderNameSchema.parse(input.provider);
  const credentialId = CredentialIdSchema.parse(input.credentialId);
  const orgId = z.uuid().parse(input.orgId);
  const apiKey = z.string().min(1).max(8_192).parse(input.apiKey);
  const dek = randomBytes(AES_KEY_BYTES);
  const encryptedKey = encodeParts(
    encryptAesGcm(Buffer.from(apiKey, "utf8"), dek, credentialAad(orgId, provider, credentialId)),
  );
  const active = input.kekProvider.active();
  const wrappedDek = encodeParts(
    encryptAesGcm(dek, active.key, dekWrapAad(orgId, provider, credentialId)),
  );
  return EncryptedAiCredentialSchema.parse({
    credential_id: credentialId,
    org_id: orgId,
    provider,
    key_ciphertext: encryptedKey.ciphertext,
    key_nonce: encryptedKey.nonce,
    key_tag: encryptedKey.tag,
    wrapped_dek: wrappedDek.ciphertext,
    dek_wrap_nonce: wrappedDek.nonce,
    dek_wrap_tag: wrappedDek.tag,
    key_version: active.key_version,
    last4: apiKey.slice(-4).padStart(4, "*"),
    status: "unverified",
  });
}

/** Decrypt only immediately before an official provider request. */
export function decryptApiKey(input: DecryptInput): string {
  const credential = EncryptedAiCredentialSchema.parse(input.credential);
  const provider = AiProviderNameSchema.parse(input.provider);
  const orgId = z.uuid().parse(input.orgId);
  if (credential.org_id !== orgId || credential.provider !== provider) {
    throw new Error("Credential authentication failed");
  }
  const kek = input.kekProvider.get(credential.key_version);
  if (kek === null) throw new Error("Credential authentication failed");
  const dek = decryptAesGcm(
    decodeParts(credential.wrapped_dek, credential.dek_wrap_nonce, credential.dek_wrap_tag),
    kek,
    dekWrapAad(orgId, provider, credential.credential_id),
  );
  const key = decryptAesGcm(
    decodeParts(credential.key_ciphertext, credential.key_nonce, credential.key_tag),
    dek,
    credentialAad(orgId, provider, credential.credential_id),
  );
  return key.toString("utf8");
}

function toMetadata(credential: EncryptedAiCredential): AiCredentialMetadata {
  return Object.freeze({
    credential_id: credential.credential_id,
    provider: credential.provider,
    last4: credential.last4,
    key_version: credential.key_version,
    status: credential.status,
  });
}

/** Memory store is test/local-only; production must inject the PG-backed equivalent. */
export function createMemoryAiCredentialStore(): AiCredentialStore {
  const credentials = new Map<string, EncryptedAiCredential>();
  return Object.freeze({
    async save(tenant, credential): Promise<void> {
      if (credential.org_id !== tenant.orgId) throw new Error("Credential tenant mismatch");
      credentials.set(credential.credential_id, credential);
    },
    async get(tenant, credentialId): Promise<EncryptedAiCredential | null> {
      const value = credentials.get(CredentialIdSchema.parse(credentialId));
      return value?.org_id === tenant.orgId ? value : null;
    },
    async list(tenant): Promise<readonly AiCredentialMetadata[]> {
      return Object.freeze(
        [...credentials.values()]
          .filter((credential) => credential.org_id === tenant.orgId)
          .map(toMetadata)
          .sort((left, right) => left.credential_id.localeCompare(right.credential_id)),
      );
    },
    async setStatus(tenant, credentialId, status): Promise<void> {
      const credential = credentials.get(CredentialIdSchema.parse(credentialId));
      if (credential === undefined || credential.org_id !== tenant.orgId) return;
      credentials.set(credentialId, EncryptedAiCredentialSchema.parse({ ...credential, status }));
    },
  });
}

type CredentialSqlRow = Readonly<{
  credential_id: string;
  org_id: string;
  provider: string;
  key_ciphertext: string;
  key_nonce: string;
  key_tag: string;
  wrapped_dek: string;
  dek_wrap_nonce: string;
  dek_wrap_tag: string;
  key_version: string;
  last4: string;
  status: string;
}>;

function parseSqlCredential(row: CredentialSqlRow): EncryptedAiCredential {
  return EncryptedAiCredentialSchema.parse(row);
}

async function insertCredential(
  client: SqlClient,
  tenant: TenantContext,
  credential: EncryptedAiCredential,
): Promise<void> {
  await client.query(
    `INSERT INTO ai_credentials (
      id, org_id, provider, key_ciphertext, key_nonce, key_tag, wrapped_dek,
      dek_wrap_nonce, dek_wrap_tag, key_version, last4, status, created_by_staff_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      credential.credential_id,
      credential.org_id,
      credential.provider,
      credential.key_ciphertext,
      credential.key_nonce,
      credential.key_tag,
      credential.wrapped_dek,
      credential.dek_wrap_nonce,
      credential.dek_wrap_tag,
      credential.key_version,
      credential.last4,
      credential.status,
      tenant.staffId,
    ],
  );
  await insertCredentialEvent(
    client,
    tenant,
    credential.credential_id,
    "created",
    credential.status,
  );
}

async function insertCredentialEvent(
  client: SqlClient,
  tenant: TenantContext,
  credentialId: string,
  action: "created" | "verification_succeeded" | "verification_failed",
  status: AiCredentialStatus,
): Promise<void> {
  await client.query(
    `INSERT INTO ai_credential_events (
      id, org_id, store_id, credential_id, actor_staff_id, action, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), tenant.orgId, tenant.storeId, credentialId, tenant.staffId, action, status],
  );
}

/** PostgreSQL credential repository; every operation receives server-injected tenant GUCs. */
export function createPgAiCredentialStore(run: TenantSqlRunner): AiCredentialStore {
  return Object.freeze({
    async save(tenant, credential): Promise<void> {
      if (credential.org_id !== tenant.orgId) throw new Error("Credential tenant mismatch");
      await run(tenant, (client) => insertCredential(client, tenant, credential));
    },
    async get(tenant, credentialId): Promise<EncryptedAiCredential | null> {
      const id = CredentialIdSchema.parse(credentialId);
      return run(tenant, async (client) => {
        const result = await client.query<CredentialSqlRow>(
          `SELECT id AS credential_id, org_id, provider, key_ciphertext, key_nonce, key_tag,
             wrapped_dek, dek_wrap_nonce, dek_wrap_tag, key_version, last4, status
             FROM ai_credentials WHERE id = $1`,
          [id],
        );
        const row = result.rows[0];
        return row === undefined ? null : parseSqlCredential(row);
      });
    },
    async list(tenant): Promise<readonly AiCredentialMetadata[]> {
      return run(tenant, async (client) => {
        const result = await client.query<CredentialSqlRow>(
          `SELECT id AS credential_id, org_id, provider, key_ciphertext, key_nonce, key_tag,
             wrapped_dek, dek_wrap_nonce, dek_wrap_tag, key_version, last4, status
             FROM ai_credentials ORDER BY created_at ASC, id ASC`,
        );
        return Object.freeze(result.rows.map(parseSqlCredential).map(toMetadata));
      });
    },
    async setStatus(tenant, credentialId, status): Promise<void> {
      const id = CredentialIdSchema.parse(credentialId);
      const parsedStatus = AiCredentialStatusSchema.parse(status);
      await run(tenant, async (client) => {
        const result = await client.query(
          "UPDATE ai_credentials SET status = $2, verified_at = now() WHERE id = $1",
          [id, parsedStatus],
        );
        if ((result.rowCount ?? 0) === 0) return;
        const action =
          parsedStatus === "verified" ? "verification_succeeded" : "verification_failed";
        await insertCredentialEvent(client, tenant, id, action, parsedStatus);
      });
    },
  });
}

export const newAiCredentialId = (): string => randomUUID();
