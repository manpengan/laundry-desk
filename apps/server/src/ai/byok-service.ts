import { timingSafeEqual } from "node:crypto";

import {
  AiCredentialIntentRequestSchema,
  type AiCredentialIntentRequest,
  type AiCredentialMetadata,
  type AiModelMetadata,
  type CommandErrorCode,
} from "@laundry/contracts";

import { writeAudit } from "../audit/write-audit.js";
import type { AuthorizedSession } from "../auth/session-view.js";
import type { TenantContext } from "../db/types.js";
import { newUuid } from "../identity/crypto-util.js";
import type { PendingAction, EntityVersion } from "../pending-actions/types.js";
import { verifyStepUpProof } from "../policy/step-up.js";
import { encryptCredential } from "./byok-envelope.js";
import { requesterAuthorityIsCurrent } from "./byok-requester-authority.js";
import type { ByokRuntime } from "./byok-runtime.js";
import { credentialMetadata, type ByokTransactionContext } from "./byok-types.js";

const REPLACE_COMMAND = "ai.provider_credential.replace";
const REVOKE_COMMAND = "ai.provider_credential.revoke";
const COMMAND_VERSION = "1.0.0";

export class ByokServiceError extends Error {
  override readonly name = "ByokServiceError";
  constructor(readonly code: CommandErrorCode) {
    super("BYOK operation failed");
  }
}

type ProofInput = Readonly<{
  confirmRef: string;
  proofId: string;
  authorized: AuthorizedSession;
}>;

type VerifiedAuthorization = Readonly<{
  pending: PendingAction;
  intent: AiCredentialIntentRequest;
  approverStaffId: string;
}>;

function tenantOf(authorized: AuthorizedSession): TenantContext {
  return Object.freeze({
    orgId: authorized.session.org_id,
    storeId: authorized.session.store_id,
    staffId: authorized.session.staff_id,
  });
}

function arraysEqual(left: readonly EntityVersion[], right: readonly EntityVersion[]): boolean {
  if (left.length !== right.length) return false;
  const leftBytes = Buffer.from(JSON.stringify(left), "utf8");
  const rightBytes = Buffer.from(JSON.stringify(right), "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireIntent(pending: PendingAction): AiCredentialIntentRequest {
  const parsed = AiCredentialIntentRequestSchema.safeParse(pending.args);
  const expectedCommand =
    parsed.success && parsed.data.operation === "replace" ? REPLACE_COMMAND : REVOKE_COMMAND;
  if (
    !parsed.success ||
    pending.command !== expectedCommand ||
    pending.commandVersion !== COMMAND_VERSION
  ) {
    throw new ByokServiceError("POLICY_DENIED");
  }
  return parsed.data;
}

async function readVerifiedAuthorization(
  runtime: ByokRuntime,
  input: ProofInput,
  transaction?: ByokTransactionContext,
): Promise<VerifiedAuthorization> {
  const tenant = tenantOf(input.authorized);
  const context = transaction ?? Object.freeze({ tenant });
  const pending = await runtime.local.pendingStore.get(input.confirmRef, context);
  const proof = await runtime.local.stepUpProofStore.get(input.proofId, context);
  const now = runtime.local.identity.sessions.clock.nowEpochSeconds();
  if (pending === null || proof === null || proof.proofId !== input.proofId) {
    throw new ByokServiceError("POLICY_DENIED");
  }
  const verified = verifyStepUpProof(proof, pending, now, {
    sessionId: input.authorized.session.session_id,
    sessionVersion: input.authorized.session.session_version,
  });
  if (verified.ok === false || pending.creatorStaffId !== tenant.staffId) {
    throw new ByokServiceError("POLICY_DENIED");
  }
  const intent = requireIntent(pending);
  if (transaction !== undefined) {
    const approverOk = await runtime.local.stepUpApproverAuthority(
      transaction.client,
      transaction.tenant,
      proof.approverStaffId,
    );
    const requesterOk = await requesterAuthorityIsCurrent(runtime, input.authorized, transaction);
    const currentVersions = await runtime.store.snapshotProvider(intent.provider_code, transaction);
    if (!requesterOk || !approverOk || !arraysEqual(currentVersions, pending.entityVersions)) {
      throw new ByokServiceError("POLICY_DENIED");
    }
  }
  return Object.freeze({ pending, intent, approverStaffId: proof.approverStaffId });
}

async function consumeAuthorization(
  runtime: ByokRuntime,
  input: ProofInput,
  verified: VerifiedAuthorization,
  transaction: ByokTransactionContext,
): Promise<void> {
  const now = runtime.local.identity.sessions.clock.nowEpochSeconds();
  const proofConsumed = await runtime.local.stepUpProofStore.atomicConsume(
    input.proofId,
    now,
    transaction,
  );
  if (!proofConsumed) throw new ByokServiceError("POLICY_DENIED");
  const pendingConsumed = await runtime.local.pendingStore.atomicConsume(
    input.confirmRef,
    verified.approverStaffId,
    { nowEpochSeconds: now, expectedArgsHash: verified.pending.argsHash, transaction },
  );
  if (!pendingConsumed.ok) throw new ByokServiceError("POLICY_DENIED");
}

async function bindDatabaseOperation(
  transaction: ByokTransactionContext,
  input: ProofInput,
): Promise<void> {
  await transaction.client.query(
    `SELECT set_config('app.byok_operation_ref', $1, true),
            set_config('app.byok_proof_ref', $2, true)`,
    [input.confirmRef, input.proofId],
  );
}

async function auditMutation(
  transaction: ByokTransactionContext,
  input: ProofInput,
  command: string,
  credentialId: string,
  providerCode: string,
  status: string,
  at: Date,
): Promise<void> {
  await writeAudit(transaction.client, {
    id: newUuid(),
    orgId: transaction.tenant.orgId,
    storeId: transaction.tenant.storeId,
    staffId: transaction.tenant.staffId,
    via: "ui",
    command,
    idempotencyKey: input.confirmRef,
    dryRun: false,
    entity: "ai_provider_key",
    entityId: credentialId,
    beforeJson: null,
    afterJson: JSON.stringify({ provider_code: providerCode, status }),
    ip: null,
    deviceId: input.authorized.session.device_id,
    at,
  });
}

function intentMatches(existing: PendingAction, input: AiCredentialIntentRequest): boolean {
  const parsed = AiCredentialIntentRequestSchema.safeParse(existing.args);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(input);
}

export function createByokService(runtime: ByokRuntime) {
  return Object.freeze({
    async listModels(): Promise<readonly AiModelMetadata[]> {
      return runtime.store.listModels();
    },

    async listCredentials(authorized: AuthorizedSession): Promise<readonly AiCredentialMetadata[]> {
      return runtime.store.listCredentialMetadata({ tenant: tenantOf(authorized) });
    },

    async createIntent(authorized: AuthorizedSession, raw: unknown) {
      const input = AiCredentialIntentRequestSchema.parse(raw);
      if (input.operation === "replace" && runtime.kms === null) {
        throw new ByokServiceError("RESOURCE_UNAVAILABLE");
      }
      const tenant = tenantOf(authorized);
      return runtime.transact(tenant, async (transaction) => {
        // Match confirmation order (provider before pending) to avoid a
        // provider/pending advisory-lock cycle under concurrent R5 requests.
        const entityVersions = await runtime.store.snapshotProvider(
          input.provider_code,
          transaction,
        );
        await runtime.local.pendingStore.lockPrivacy(transaction);
        const existing = await runtime.local.pendingStore.findByIdempotency(
          input.operation === "replace" ? REPLACE_COMMAND : REVOKE_COMMAND,
          input.idempotency_key,
          transaction,
        );
        if (existing !== null) {
          if (!intentMatches(existing, input) || existing.status !== "pending") {
            throw new ByokServiceError("IDEMPOTENCY_CONFLICT");
          }
          return Object.freeze({
            confirm_ref: existing.nonce,
            operation: input.operation,
            provider_code: input.provider_code,
            ...(input.operation === "revoke" ? { credential_ref: input.credential_ref } : {}),
            expires_at: existing.expiresAt,
          });
        }
        if (input.operation === "revoke") {
          const target = await runtime.store.findCredentialMetadata(
            input.credential_ref,
            transaction,
          );
          if (
            target === null ||
            target.provider_code !== input.provider_code ||
            target.status === "revoked" ||
            target.status === "superseded"
          ) {
            throw new ByokServiceError("RESOURCE_UNAVAILABLE");
          }
        }
        const nonce = newUuid();
        const createdAt = runtime.local.identity.sessions.clock.nowEpochSeconds();
        if (input.operation === "replace" && entityVersions.length >= 100) {
          throw new ByokServiceError("RESOURCE_UNAVAILABLE");
        }
        const pending = await runtime.local.pendingStore.create(
          {
            nonce,
            command: input.operation === "replace" ? REPLACE_COMMAND : REVOKE_COMMAND,
            commandVersion: COMMAND_VERSION,
            args: input,
            entityVersions,
            creatorStaffId: tenant.staffId,
            orgId: tenant.orgId,
            storeId: tenant.storeId,
            idempotencyKey: input.idempotency_key,
            createdAt,
            effectiveRisk: "R5",
            policyOutcome: "step_up",
            requiresOtherApprover: true,
          },
          transaction,
        );
        return Object.freeze({
          confirm_ref: pending.nonce,
          operation: input.operation,
          provider_code: input.provider_code,
          ...(input.operation === "revoke" ? { credential_ref: input.credential_ref } : {}),
          expires_at: pending.expiresAt,
        });
      });
    },

    async replaceCredential(input: ProofInput & Readonly<{ apiKey: Buffer }>) {
      try {
        const kms = runtime.kms;
        if (kms === null) throw new ByokServiceError("RESOURCE_UNAVAILABLE");
        const preflight = await readVerifiedAuthorization(runtime, input);
        if (preflight.intent.operation !== "replace") {
          throw new ByokServiceError("POLICY_DENIED");
        }
        const credentialId = newUuid();
        const last4 = input.apiKey.subarray(-4).toString("ascii");
        const envelope = await encryptCredential(
          kms,
          {
            orgId: input.authorized.session.org_id,
            providerCode: preflight.intent.provider_code,
            credentialId,
          },
          input.apiKey,
        );
        return runtime.transact(tenantOf(input.authorized), async (transaction) => {
          const verified = await readVerifiedAuthorization(runtime, input, transaction);
          if (verified.intent.operation !== "replace") {
            throw new ByokServiceError("POLICY_DENIED");
          }
          const credentialVersion = await runtime.store.nextCredentialVersion(
            verified.intent.provider_code,
            transaction,
          );
          const now = new Date(runtime.local.identity.sessions.clock.nowEpochSeconds() * 1_000);
          await consumeAuthorization(runtime, input, verified, transaction);
          await bindDatabaseOperation(transaction, input);
          await runtime.store.stageCredential(
            Object.freeze({
              id: credentialId,
              orgId: transaction.tenant.orgId,
              providerCode: verified.intent.provider_code,
              credentialVersion,
              rowVersion: 1,
              status: "pending_verification" as const,
              envelope,
              last4,
              createdByStaffId: transaction.tenant.staffId,
              createdAt: now,
              updatedByStaffId: transaction.tenant.staffId,
              updatedAt: now,
              activatedAt: null,
              revokedAt: null,
              supersededAt: null,
            }),
            transaction,
          );
          const stored = await runtime.store.findCredential(credentialId, transaction);
          if (stored === null) throw new ByokServiceError("TRANSACTION_FAILED");
          await auditMutation(
            transaction,
            input,
            REPLACE_COMMAND,
            credentialId,
            verified.intent.provider_code,
            "pending_verification",
            stored.updatedAt,
          );
          return credentialMetadata(stored);
        });
      } finally {
        input.apiKey.fill(0);
      }
    },

    async revokeCredential(input: ProofInput & Readonly<{ credentialRef: string }>) {
      return runtime.transact(tenantOf(input.authorized), async (transaction) => {
        const verified = await readVerifiedAuthorization(runtime, input, transaction);
        if (
          verified.intent.operation !== "revoke" ||
          verified.intent.credential_ref !== input.credentialRef
        ) {
          throw new ByokServiceError("POLICY_DENIED");
        }
        await consumeAuthorization(runtime, input, verified, transaction);
        await bindDatabaseOperation(transaction, input);
        const changed = await runtime.store.revokeCredential(
          input.credentialRef,
          transaction.tenant.staffId,
          new Date(runtime.local.identity.sessions.clock.nowEpochSeconds() * 1_000),
          transaction,
        );
        if (changed === null) throw new ByokServiceError("RESOURCE_UNAVAILABLE");
        await auditMutation(
          transaction,
          input,
          REVOKE_COMMAND,
          changed.credential_ref,
          changed.provider_code,
          changed.status,
          new Date(changed.updated_at),
        );
        return changed;
      });
    },
  });
}

export type ByokService = ReturnType<typeof createByokService>;
