import type { AiCredentialMetadata, AiModelMetadata } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { CredentialEnvelope } from "./byok-envelope.js";

export type CredentialStatus = AiCredentialMetadata["status"];

export type StoredCredential = Readonly<{
  id: string;
  orgId: string;
  providerCode: string;
  credentialVersion: number;
  rowVersion: number;
  status: CredentialStatus;
  envelope: CredentialEnvelope;
  last4: string;
  createdByStaffId: string;
  createdAt: Date;
  updatedByStaffId: string;
  updatedAt: Date;
  activatedAt: Date | null;
  revokedAt: Date | null;
  supersededAt: Date | null;
}>;

export type ByokStoreContext = Readonly<{
  tenant: TenantContext;
  client?: SqlClient;
}>;

export type ByokTransactionContext = Readonly<{
  tenant: TenantContext;
  client: SqlClient;
}>;

export type ByokStore = Readonly<{
  listModels(context?: ByokStoreContext): Promise<readonly AiModelMetadata[]>;
  listCredentialMetadata(context: ByokStoreContext): Promise<readonly AiCredentialMetadata[]>;
  findCredentialMetadata(
    id: string,
    context: ByokStoreContext,
  ): Promise<AiCredentialMetadata | null>;
  findCredential(id: string, context: ByokStoreContext): Promise<StoredCredential | null>;
  nextCredentialVersion(providerCode: string, context: ByokTransactionContext): Promise<number>;
  snapshotProvider(
    providerCode: string,
    context: ByokStoreContext,
  ): Promise<
    readonly Readonly<{ entityType: "ai_provider_key"; entityId: string; version: number }>[]
  >;
  stageCredential(record: StoredCredential, context: ByokTransactionContext): Promise<void>;
  revokeCredential(
    id: string,
    actorStaffId: string,
    now: Date,
    context: ByokTransactionContext,
  ): Promise<AiCredentialMetadata | null>;
  activateCredential(
    id: string,
    actorStaffId: string,
    now: Date,
    context: ByokTransactionContext,
  ): Promise<StoredCredential | null>;
  rewrapCredential(
    id: string,
    expectedRowVersion: number,
    replacement: Pick<CredentialEnvelope, "wrappedDek" | "kmsKeyId" | "kmsKeyVersion">,
    actorStaffId: string,
    now: Date,
    context: ByokTransactionContext,
  ): Promise<StoredCredential | null>;
}>;

export function credentialMetadata(record: StoredCredential): AiCredentialMetadata {
  return Object.freeze({
    credential_ref: record.id,
    provider_code: record.providerCode,
    credential_version: record.credentialVersion,
    status: record.status,
    last4: record.last4,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  });
}
