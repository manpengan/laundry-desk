import { timingSafeEqual } from "node:crypto";

import {
  AiProviderValidationIntentRequestSchema,
  type AiProviderValidationErrorCode,
  type AiProviderValidationIntentRequest,
  type AiProviderValidationResult,
} from "@laundry/contracts";
import { z } from "zod";

import { writeAudit } from "../audit/write-audit.js";
import type { AuthorizedSession } from "../auth/session-view.js";
import type { TenantContext } from "../db/types.js";
import { newUuid } from "../identity/crypto-util.js";
import { createSqlFeaturesStore } from "../platform/features.js";
import type { EntityVersion, PendingAction } from "../pending-actions/types.js";
import { createByokCredentialAuthority } from "./provider-credential-authority.js";
import { createProviderAdapter } from "./provider-registry.js";
import { requesterAuthorityIsCurrent } from "./byok-requester-authority.js";
import type { ByokRuntime } from "./byok-runtime.js";
import type { ByokTransactionContext, StoredCredential } from "./byok-types.js";
import type { ProviderHttpPort } from "./provider-http.js";
import { ProviderAdapterError, ProviderCodeSchema } from "./provider-types.js";

const COMMAND = "ai.provider_connection.validate";
const COMMAND_VERSION = "1.0.0";

const FrozenValidationSchema = z
  .object({
    providerCode: ProviderCodeSchema,
    credentialRef: z.uuid(),
    credentialVersion: z.number().int().positive(),
    credentialRowVersion: z.number().int().positive(),
    modelId: z.string().min(1).max(128),
    registryVersion: z.number().int().positive().nullable(),
    idempotencyKey: z.uuid(),
  })
  .strict();
type FrozenValidation = Readonly<z.output<typeof FrozenValidationSchema>>;

export class ProviderValidationServiceError extends Error {
  override readonly name = "ProviderValidationServiceError";
  constructor(readonly code: "RESOURCE_UNAVAILABLE" | "POLICY_DENIED" | "IDEMPOTENCY_CONFLICT") {
    super(code);
  }
}

function tenantOf(authorized: AuthorizedSession): TenantContext {
  return Object.freeze({
    orgId: authorized.session.org_id,
    storeId: authorized.session.store_id,
    staffId: authorized.session.staff_id,
  });
}

function versionsEqual(left: readonly EntityVersion[], right: readonly EntityVersion[]): boolean {
  const lhs = Buffer.from(JSON.stringify(left));
  const rhs = Buffer.from(JSON.stringify(right));
  try {
    return lhs.byteLength === rhs.byteLength && timingSafeEqual(lhs, rhs);
  } finally {
    lhs.fill(0);
    rhs.fill(0);
  }
}

async function aiEnabled(runtime: ByokRuntime, context: ByokTransactionContext): Promise<boolean> {
  const features =
    runtime.local.platform.persistence === "sql"
      ? createSqlFeaturesStore(context.client, context.tenant)
      : runtime.local.platform.features;
  return (await features.get(context.tenant.storeId)).ai;
}

function requirePending(
  action: PendingAction | null,
  authorized: AuthorizedSession,
  now: number,
): FrozenValidation {
  const parsed = FrozenValidationSchema.safeParse(action?.args);
  if (
    action === null ||
    !parsed.success ||
    action.command !== COMMAND ||
    action.commandVersion !== COMMAND_VERSION ||
    action.status !== "pending" ||
    action.expiresAt <= now ||
    action.orgId !== authorized.session.org_id ||
    action.storeId !== authorized.session.store_id ||
    action.creatorStaffId !== authorized.session.staff_id
  )
    throw new ProviderValidationServiceError("POLICY_DENIED");
  return parsed.data;
}

function summary(record: StoredCredential, modelId: string) {
  return Object.freeze({
    provider_code: record.providerCode,
    credential_ref: record.id,
    credential_version: record.credentialVersion,
    credential_last4: record.last4,
    model_id: modelId,
  });
}

function intentMatches(action: PendingAction, input: AiProviderValidationIntentRequest): boolean {
  const parsed = FrozenValidationSchema.safeParse(action.args);
  return (
    parsed.success &&
    parsed.data.credentialRef === input.credential_ref &&
    parsed.data.modelId === input.model_id &&
    parsed.data.idempotencyKey === input.idempotency_key
  );
}

export function createProviderValidationService(runtime: ByokRuntime, http?: ProviderHttpPort) {
  return Object.freeze({
    async createIntent(authorized: AuthorizedSession, raw: unknown) {
      const input = AiProviderValidationIntentRequestSchema.parse(raw);
      const tenant = tenantOf(authorized);
      return runtime.transact(tenant, async (transaction) => {
        if (!(await aiEnabled(runtime, transaction))) {
          throw new ProviderValidationServiceError("RESOURCE_UNAVAILABLE");
        }
        const record = await runtime.store.findCredential(input.credential_ref, transaction);
        const provider = ProviderCodeSchema.safeParse(record?.providerCode);
        if (record === null || record.status !== "pending_verification" || !provider.success) {
          throw new ProviderValidationServiceError("RESOURCE_UNAVAILABLE");
        }
        const models = await runtime.store.listModels(transaction);
        const registry = models.find(
          (model) =>
            model.provider_code === record.providerCode && model.model_id === input.model_id,
        );
        const entityVersions = await runtime.store.snapshotProvider(
          record.providerCode,
          transaction,
        );
        await runtime.local.pendingStore.lockPrivacy(transaction);
        const existing = await runtime.local.pendingStore.findByIdempotency(
          COMMAND,
          input.idempotency_key,
          transaction,
        );
        if (existing !== null) {
          if (!intentMatches(existing, input) || existing.status !== "pending") {
            throw new ProviderValidationServiceError("IDEMPOTENCY_CONFLICT");
          }
          return Object.freeze({
            confirm_ref: existing.nonce,
            expires_at: existing.expiresAt,
            summary: summary(record, input.model_id),
          });
        }
        const args: FrozenValidation = Object.freeze({
          providerCode: provider.data,
          credentialRef: record.id,
          credentialVersion: record.credentialVersion,
          credentialRowVersion: record.rowVersion,
          modelId: input.model_id,
          registryVersion: registry?.registry_version ?? null,
          idempotencyKey: input.idempotency_key,
        });
        const created = await runtime.local.pendingStore.create(
          {
            nonce: newUuid(),
            command: COMMAND,
            commandVersion: COMMAND_VERSION,
            args,
            entityVersions,
            creatorStaffId: tenant.staffId,
            orgId: tenant.orgId,
            storeId: tenant.storeId,
            idempotencyKey: input.idempotency_key,
            createdAt: runtime.local.identity.sessions.clock.nowEpochSeconds(),
            effectiveRisk: "R3",
            policyOutcome: "confirm",
            requiresOtherApprover: false,
          },
          transaction,
        );
        return Object.freeze({
          confirm_ref: created.nonce,
          expires_at: created.expiresAt,
          summary: summary(record, input.model_id),
        });
      });
    },

    async validate(
      authorized: AuthorizedSession,
      confirmRef: string,
      signal: AbortSignal,
    ): Promise<AiProviderValidationResult> {
      const tenant = tenantOf(authorized);
      const pending = await runtime.local.pendingStore.get(confirmRef, { tenant });
      const frozen = requirePending(
        pending,
        authorized,
        runtime.local.identity.sessions.clock.nowEpochSeconds(),
      );
      const authority = createByokCredentialAuthority({
        runtime,
        tenant,
        providerCode: frozen.providerCode,
        credentialRef: frozen.credentialRef,
        expectedCredentialVersion: frozen.credentialVersion,
        allowedStatuses: Object.freeze(["pending_verification"]),
      });
      const adapter = createProviderAdapter({
        providerCode: frozen.providerCode,
        modelId: frozen.modelId,
        credentialAuthority: authority,
        ...(http === undefined ? {} : { http }),
      });
      const validatedAt = new Date(runtime.local.identity.sessions.clock.nowEpochSeconds() * 1_000);
      let discovery;
      try {
        discovery = await adapter.discoverModels(signal);
      } catch (error) {
        const code: AiProviderValidationErrorCode =
          error instanceof ProviderAdapterError ? error.code : "NETWORK_ERROR";
        return Object.freeze({
          outcome: "failed",
          provider_code: frozen.providerCode,
          credential_ref: frozen.credentialRef,
          credential_version: frozen.credentialVersion,
          model_id: frozen.modelId,
          discovered_model_count: 0,
          selected_model_available: false,
          error_code: code,
          validated_at: validatedAt.toISOString(),
        });
      }
      if (!discovery.selectedModelAvailable) {
        return Object.freeze({
          outcome: "failed",
          provider_code: frozen.providerCode,
          credential_ref: frozen.credentialRef,
          credential_version: frozen.credentialVersion,
          model_id: frozen.modelId,
          discovered_model_count: discovery.models.length,
          selected_model_available: false,
          error_code: "PROVIDER_RESPONSE_INVALID",
          validated_at: validatedAt.toISOString(),
        });
      }
      await runtime.transact(tenant, async (transaction) => {
        if (
          !(await aiEnabled(runtime, transaction)) ||
          !(await requesterAuthorityIsCurrent(runtime, authorized, transaction))
        ) {
          throw new ProviderValidationServiceError("POLICY_DENIED");
        }
        const currentPending = await runtime.local.pendingStore.get(confirmRef, transaction);
        const currentFrozen = requirePending(
          currentPending,
          authorized,
          runtime.local.identity.sessions.clock.nowEpochSeconds(),
        );
        const currentVersions = await runtime.store.snapshotProvider(
          frozen.providerCode,
          transaction,
        );
        const record = await runtime.store.findCredential(frozen.credentialRef, transaction);
        const registry = (await runtime.store.listModels(transaction)).find(
          (model) =>
            model.provider_code === frozen.providerCode && model.model_id === frozen.modelId,
        );
        if (
          currentPending === null ||
          JSON.stringify(currentFrozen) !== JSON.stringify(frozen) ||
          !versionsEqual(currentVersions, currentPending.entityVersions) ||
          record === null ||
          record.status !== "pending_verification" ||
          record.rowVersion !== frozen.credentialRowVersion ||
          record.credentialVersion !== frozen.credentialVersion ||
          (registry?.registry_version ?? null) !== frozen.registryVersion
        )
          throw new ProviderValidationServiceError("POLICY_DENIED");
        const consumed = await runtime.local.pendingStore.atomicConsume(
          confirmRef,
          tenant.staffId,
          {
            nowEpochSeconds: runtime.local.identity.sessions.clock.nowEpochSeconds(),
            expectedArgsHash: currentPending.argsHash,
            transaction,
          },
        );
        if (!consumed.ok) throw new ProviderValidationServiceError("POLICY_DENIED");
        const active = await runtime.store.activateCredential(
          record.id,
          tenant.staffId,
          validatedAt,
          transaction,
        );
        if (active === null) throw new ProviderValidationServiceError("POLICY_DENIED");
        await writeAudit(transaction.client, {
          id: newUuid(),
          orgId: tenant.orgId,
          storeId: tenant.storeId,
          staffId: tenant.staffId,
          via: "ui",
          command: COMMAND,
          idempotencyKey: pending?.idempotencyKey ?? null,
          dryRun: false,
          entity: "ai_provider_key",
          entityId: record.id,
          beforeJson: null,
          afterJson: JSON.stringify({ provider_code: record.providerCode, status: "active" }),
          ip: null,
          deviceId: authorized.session.device_id,
          at: validatedAt,
        });
      });
      return Object.freeze({
        outcome: "valid",
        provider_code: frozen.providerCode,
        credential_ref: frozen.credentialRef,
        credential_version: frozen.credentialVersion,
        model_id: frozen.modelId,
        discovered_model_count: discovery.models.length,
        selected_model_available: discovery.selectedModelAvailable,
        error_code: null,
        validated_at: validatedAt.toISOString(),
      });
    },
  });
}

export type ProviderValidationService = ReturnType<typeof createProviderValidationService>;
