import type { AiModelMetadata } from "@laundry/contracts";

import {
  readMemoryTransactionState,
  writeMemoryTransactionState,
} from "../db/memory-unit-of-work.js";
import {
  credentialMetadata,
  type ByokStore,
  type ByokStoreContext,
  type ByokTransactionContext,
  type StoredCredential,
} from "./byok-types.js";

function copyCredential(record: StoredCredential): StoredCredential {
  return Object.freeze({
    ...record,
    envelope: Object.freeze({
      ...record.envelope,
      ciphertext: Buffer.from(record.envelope.ciphertext),
      nonce: Buffer.from(record.envelope.nonce),
      authTag: Buffer.from(record.envelope.authTag),
      wrappedDek: Buffer.from(record.envelope.wrappedDek),
    }),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    activatedAt: record.activatedAt === null ? null : new Date(record.activatedAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
    supersededAt: record.supersededAt === null ? null : new Date(record.supersededAt),
  });
}

function scoped(record: StoredCredential, context: ByokStoreContext): boolean {
  return record.orgId === context.tenant.orgId;
}

export class MemoryByokStore implements ByokStore {
  private credentials: ReadonlyMap<string, StoredCredential> = new Map();

  constructor(private readonly models: readonly AiModelMetadata[] = Object.freeze([])) {}

  async listModels(): Promise<readonly AiModelMetadata[]> {
    return Object.freeze(this.models.map((model) => Object.freeze({ ...model })));
  }

  async listCredentials(context: ByokStoreContext): Promise<readonly StoredCredential[]> {
    const rows = [...this.state().values()]
      .filter((record) => scoped(record, context))
      .sort(
        (left, right) =>
          left.providerCode.localeCompare(right.providerCode) ||
          right.credentialVersion - left.credentialVersion,
      )
      .map(copyCredential);
    if (rows.length > 500) throw new Error("Credential history exceeds the bounded limit");
    return Object.freeze(rows);
  }

  async listCredentialMetadata(context: ByokStoreContext) {
    return Object.freeze((await this.listCredentials(context)).map(credentialMetadata));
  }

  async findCredentialMetadata(id: string, context: ByokStoreContext) {
    const record = await this.findCredential(id, context);
    return record === null ? null : credentialMetadata(record);
  }

  async findCredential(id: string, context: ByokStoreContext): Promise<StoredCredential | null> {
    const record = this.state().get(id);
    return record !== undefined && scoped(record, context) ? copyCredential(record) : null;
  }

  async nextCredentialVersion(
    providerCode: string,
    context: ByokTransactionContext,
  ): Promise<number> {
    const versions = [...this.state().values()]
      .filter((record) => scoped(record, context) && record.providerCode === providerCode)
      .map((record) => record.credentialVersion);
    return Math.max(0, ...versions) + 1;
  }

  async snapshotProvider(providerCode: string, context: ByokStoreContext) {
    const rows = [...this.state().values()]
      .filter((record) => scoped(record, context) && record.providerCode === providerCode)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) =>
        Object.freeze({
          entityType: "ai_provider_key" as const,
          entityId: record.id,
          version: record.rowVersion,
        }),
      );
    if (rows.length > 100) throw new Error("Provider credential history exceeds the bounded limit");
    return Object.freeze(rows);
  }

  async stageCredential(record: StoredCredential, context: ByokTransactionContext): Promise<void> {
    if (record.orgId !== context.tenant.orgId || record.status !== "pending_verification") {
      throw new Error("Credential scope or initial state is invalid");
    }
    const current = this.state();
    const sameProvider = [...current.values()].filter(
      (item) => item.orgId === record.orgId && item.providerCode === record.providerCode,
    );
    const expectedVersion = Math.max(0, ...sameProvider.map((item) => item.credentialVersion)) + 1;
    if (current.has(record.id) || record.credentialVersion !== expectedVersion) {
      throw new Error("Credential version authority changed");
    }
    const next = new Map(current);
    for (const item of sameProvider) {
      if (item.status !== "pending_verification") continue;
      next.set(
        item.id,
        copyCredential({
          ...item,
          status: "superseded",
          rowVersion: item.rowVersion + 1,
          updatedByStaffId: context.tenant.staffId,
          updatedAt: record.createdAt,
          supersededAt: record.createdAt,
        }),
      );
    }
    next.set(record.id, copyCredential(record));
    this.write(next);
  }

  async revokeCredential(
    id: string,
    actorStaffId: string,
    now: Date,
    context: ByokTransactionContext,
  ) {
    const changed = await this.transition(id, context, (record) => {
      if (record.status === "revoked" || record.status === "superseded") return null;
      return copyCredential({
        ...record,
        status: "revoked",
        rowVersion: record.rowVersion + 1,
        updatedByStaffId: actorStaffId,
        updatedAt: now,
        revokedAt: now,
      });
    });
    return changed === null ? null : credentialMetadata(changed);
  }

  async activateCredential(
    id: string,
    actorStaffId: string,
    now: Date,
    context: ByokTransactionContext,
  ): Promise<StoredCredential | null> {
    const current = this.state();
    const target = current.get(id);
    if (
      target === undefined ||
      !scoped(target, context) ||
      target.status !== "pending_verification"
    ) {
      return null;
    }
    const next = new Map(current);
    for (const record of current.values()) {
      if (
        record.orgId === target.orgId &&
        record.providerCode === target.providerCode &&
        record.status === "active"
      ) {
        next.set(
          record.id,
          copyCredential({
            ...record,
            status: "superseded",
            rowVersion: record.rowVersion + 1,
            updatedByStaffId: actorStaffId,
            updatedAt: now,
            supersededAt: now,
          }),
        );
      }
    }
    const activated = copyCredential({
      ...target,
      status: "active",
      rowVersion: target.rowVersion + 1,
      updatedByStaffId: actorStaffId,
      updatedAt: now,
      activatedAt: now,
    });
    next.set(id, activated);
    this.write(next);
    return copyCredential(activated);
  }

  async rewrapCredential(
    id: string,
    expectedRowVersion: number,
    replacement: Parameters<ByokStore["rewrapCredential"]>[2],
    actorStaffId: string,
    now: Date,
    context: ByokTransactionContext,
  ): Promise<StoredCredential | null> {
    return this.transition(id, context, (record) => {
      if (record.rowVersion !== expectedRowVersion || record.status === "revoked") return null;
      return copyCredential({
        ...record,
        rowVersion: record.rowVersion + 1,
        envelope: Object.freeze({ ...record.envelope, ...replacement }),
        updatedByStaffId: actorStaffId,
        updatedAt: now,
      });
    });
  }

  private state(): ReadonlyMap<string, StoredCredential> {
    return readMemoryTransactionState(this, this.credentials);
  }

  private write(next: ReadonlyMap<string, StoredCredential>): void {
    writeMemoryTransactionState(
      this,
      () => this.credentials,
      next,
      (value) => {
        this.credentials = value;
      },
    );
  }

  private async transition(
    id: string,
    context: ByokTransactionContext,
    update: (record: StoredCredential) => StoredCredential | null,
  ): Promise<StoredCredential | null> {
    const current = this.state();
    const record = current.get(id);
    if (record === undefined || !scoped(record, context)) return null;
    const changed = update(record);
    if (changed === null) return null;
    const next = new Map(current);
    next.set(id, changed);
    this.write(next);
    return copyCredential(changed);
  }
}
