/**
 * Process-local store for step-up proofs issued after PIN verify.
 * Production will swap to Postgres CAS (active → consumed).
 */

import type { StepUpProof } from "./step-up.js";

export type StepUpProofStore = Readonly<{
  insert: (proof: StepUpProof) => void;
  get: (proofId: string) => StepUpProof | null;
  /** Active proof bound to a pending-action nonce, if any. */
  findActiveByPendingRef: (pendingActionRef: string) => StepUpProof | null;
  /**
   * CAS: active → consumed. Returns true when this caller won the race.
   */
  atomicConsume: (proofId: string, nowEpochSeconds: number) => boolean;
}>;

const freezeProof = (proof: StepUpProof): StepUpProof => Object.freeze({ ...proof });

export class MemoryStepUpProofStore implements StepUpProofStore {
  private readonly byId = new Map<string, StepUpProof>();

  insert(proof: StepUpProof): void {
    if (this.byId.has(proof.proofId)) {
      throw new Error(`Step-up proof already exists: ${proof.proofId}`);
    }
    this.byId.set(proof.proofId, freezeProof(proof));
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
    this.byId.set(proofId, freezeProof({ ...current, status: "consumed" }));
    return true;
  }

  /** Test helper. */
  clear(): void {
    this.byId.clear();
  }

  size(): number {
    return this.byId.size;
  }
}

/** Shared default for local/dev single process. */
export const processStepUpProofStore = new MemoryStepUpProofStore();
