import { createCommandError } from "@laundry/contracts";

import type { PendingAction, PendingActionTransactionContext } from "../pending-actions/types.js";
import { verifyStepUpProof, type StepUpSessionBinding } from "../policy/step-up.js";
import type { StepUpProofStore } from "../policy/step-up-proof-store.js";
import { CommandBusTxnError } from "./execution-result.js";
import type { StepUpApproverAuthority } from "./types.js";

type CreatorStepUpInput = Readonly<{
  confirmRef: string;
  pending: PendingAction;
  nowEpochSeconds: number;
  sessionBinding: StepUpSessionBinding | null;
  transaction: PendingActionTransactionContext;
  proofStore: StepUpProofStore;
  approverAuthority?: StepUpApproverAuthority;
}>;

const deny = (): never => {
  throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
};

/** Revalidate and consume the other-admin proof in the business transaction. */
export async function consumeCreatorStepUpProof(input: CreatorStepUpInput): Promise<string> {
  const proof = await input.proofStore.findActiveByPendingRef(input.confirmRef, input.transaction);
  if (proof === null) {
    throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
  }
  const authority = input.approverAuthority;
  const verified = verifyStepUpProof(
    proof,
    input.pending,
    input.nowEpochSeconds,
    input.sessionBinding,
  );
  if (verified.ok === false) deny();
  if (authority === undefined) {
    throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
  }
  if (
    !(await authority(input.transaction.client, input.transaction.tenant, proof.approverStaffId))
  ) {
    deny();
  }
  if (
    !(await input.proofStore.atomicConsume(proof.proofId, input.nowEpochSeconds, input.transaction))
  ) {
    deny();
  }
  return proof.approverStaffId;
}
