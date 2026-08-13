import { createCommandError } from "@laundry/contracts";

import type { ApprovalStore } from "../approvals/types.js";
import type { SqlClient } from "../db/types.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import type { StepUpSessionBinding } from "../policy/step-up.js";
import { processStepUpProofStore, type StepUpProofStore } from "../policy/step-up-proof-store.js";
import type { ApprovalAuditEvidence } from "./audit-outcome.js";
import { CommandBusTxnError } from "./execution-result.js";
import { consumeCreatorStepUpProof } from "./step-up-confirmation.js";
import type { BusContext, StepUpApproverAuthority } from "./types.js";

type ConsumeConfirmationOptions = Readonly<{
  pendingStore: PendingActionStore;
  approvalStore?: ApprovalStore;
  approvalRef?: string;
  stepUpProofStore?: StepUpProofStore;
  stepUpApproverAuthority?: StepUpApproverAuthority;
  sessionBinding?: StepUpSessionBinding;
  now: Date;
}>;

const deny = (): never => {
  throw new CommandBusTxnError(createCommandError("POLICY_DENIED"));
};

async function otherApprover(
  context: BusContext,
  options: ConsumeConfirmationOptions,
  tx: SqlClient,
  nowEpochSeconds: number,
): Promise<string> {
  const authorization = context.confirmAuthorization;
  if (authorization === undefined) return context.actor.staffId;
  const transaction = Object.freeze({ tenant: context.tenant, client: tx });
  const pending = await options.pendingStore.get(authorization.confirmRef, transaction);
  if (
    pending === null ||
    !pending.requiresOtherApprover ||
    context.actor.staffId !== pending.creatorStaffId
  ) {
    return context.actor.staffId;
  }
  if (options.approvalRef !== undefined && options.approvalStore !== undefined) {
    if (pending.effectiveRisk !== "R4") deny();
    try {
      return (
        await options.approvalStore.consume(
          options.approvalRef,
          pending,
          nowEpochSeconds,
          transaction,
        )
      ).approverStaffId;
    } catch {
      deny();
    }
  }
  return consumeCreatorStepUpProof({
    confirmRef: authorization.confirmRef,
    pending,
    nowEpochSeconds,
    sessionBinding: options.sessionBinding ?? null,
    transaction,
    proofStore: options.stepUpProofStore ?? processStepUpProofStore,
    ...(options.stepUpApproverAuthority === undefined
      ? {}
      : { approverAuthority: options.stepUpApproverAuthority }),
  });
}

/** Consume async/sync approval plus its pending card in the business transaction. */
export async function consumeConfirmation(
  tx: SqlClient,
  context: BusContext,
  options: ConsumeConfirmationOptions,
): Promise<ApprovalAuditEvidence | undefined> {
  const authorization = context.confirmAuthorization;
  if (authorization === undefined) return undefined;
  const nowEpochSeconds = Math.floor(options.now.getTime() / 1_000);
  const transaction = Object.freeze({ tenant: context.tenant, client: tx });
  await options.pendingStore.lockPrivacy(transaction);
  const approverStaffId = await otherApprover(context, options, tx, nowEpochSeconds);
  const consumed = await options.pendingStore.atomicConsume(
    authorization.confirmRef,
    approverStaffId,
    {
      expectedArgsHash: authorization.argsHash,
      nowEpochSeconds,
      transaction,
    },
  );
  const action = consumed.ok ? consumed.action : deny();
  return action.requiresOtherApprover && action.consumedByStaffId !== null
    ? Object.freeze({
        initiatedByStaffId: action.creatorStaffId,
        approvedByStaffId: action.consumedByStaffId,
      })
    : undefined;
}
