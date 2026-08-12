/** Step-up proof authority. Production uses PostgreSQL; memory is test-only. */

import type { PendingActionTransactionContext } from "../pending-actions/types.js";
import { registerMemoryRollback } from "../db/memory-unit-of-work.js";
import type { StepUpProof } from "./step-up.js";

export type StepUpProofReadContext = Readonly<{
  tenant: PendingActionTransactionContext["tenant"];
  client?: PendingActionTransactionContext["client"];
}>;

type MaybePromise<T> = T | Promise<T>;

export type StepUpProofStore = Readonly<{
  insert: (proof: StepUpProof, context?: StepUpProofReadContext) => MaybePromise<void>;
  get: (proofId: string, context?: StepUpProofReadContext) => MaybePromise<StepUpProof | null>;
  /** Active proof bound to a pending-action nonce, if any. */
  findActiveByPendingRef: (
    pendingActionRef: string,
    context?: StepUpProofReadContext,
  ) => MaybePromise<StepUpProof | null>;
  /**
   * CAS: active → consumed. PostgreSQL callers must supply the already-open
   * command transaction so proof, pending card, business data and audit commit
   * or roll back together.
   */
  atomicConsume: (
    proofId: string,
    nowEpochSeconds: number,
    transaction?: PendingActionTransactionContext,
  ) => MaybePromise<boolean>;
}>;

const freezeProof = (proof: StepUpProof): StepUpProof => Object.freeze({ ...proof });

export class MemoryStepUpProofStore implements StepUpProofStore {
  private readonly byId = new Map<string, StepUpProof>();

  insert(proof: StepUpProof): void {
    if (this.byId.has(proof.proofId)) {
      throw new Error(`Step-up proof already exists: ${proof.proofId}`);
    }
    const frozen = freezeProof(proof);
    this.byId.set(proof.proofId, frozen);
    registerMemoryRollback(() => {
      if (this.byId.get(proof.proofId) === frozen) this.byId.delete(proof.proofId);
    });
  }

  get(proofId: string): StepUpProof | null {
    return this.byId.get(proofId) ?? null;
  }

  findActiveByPendingRef(pendingActionRef: string): StepUpProof | null {
    for (const proof of this.byId.values()) {
      if (proof.status === "active" && proof.pendingActionRef === pendingActionRef) {
        return proof;
      }
    }
    return null;
  }

  atomicConsume(proofId: string, nowEpochSeconds: number): boolean {
    const current = this.byId.get(proofId);
    if (current === undefined || current.status !== "active") return false;
    if (nowEpochSeconds >= current.expiresAt) return false;
    if (this.byId.get(proofId) !== current) return false;
    const consumed = freezeProof({ ...current, status: "consumed" });
    this.byId.set(proofId, consumed);
    registerMemoryRollback(() => {
      if (this.byId.get(proofId) === consumed) this.byId.set(proofId, current);
    });
    return true;
  }

  /** Test helper. */
  clear(): void {
    const previous = new Map(this.byId);
    this.byId.clear();
    registerMemoryRollback(() => {
      if (this.byId.size === 0) {
        for (const [proofId, proof] of previous) this.byId.set(proofId, proof);
      }
    });
  }

  size(): number {
    return this.byId.size;
  }
}

/** Shared default for local/dev single process. */
export const processStepUpProofStore = new MemoryStepUpProofStore();
