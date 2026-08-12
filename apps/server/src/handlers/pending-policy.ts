import {
  createCommandError,
  NotificationDeliveryConfirmationSummarySchema,
  type ConfirmationSummary,
} from "@laundry/contracts";

import type { BusContext } from "../bus/types.js";
import { freezeCanonical } from "../pending-actions/canonical.js";
import type {
  PendingAction,
  PendingActionStore,
  PendingActionTransactionContext,
  PendingRiskReservation,
  PendingRiskReservationRequest,
} from "../pending-actions/types.js";
import { PendingRiskCapacityExceededError } from "../pending-actions/types.js";

export type PendingActionPreparation = Readonly<{
  /** Trusted server-derived snapshot, hash-bound to the pending card. */
  authority: unknown;
  /** Public confirmation summary derived from the same snapshot. */
  summary?: ConfirmationSummary;
  /** Store-wide risk units that must be measured under the pending policy lock. */
  riskReservation?: PendingRiskReservationRequest;
  /** Database-owned epoch returned with a durable risk measurement. */
  createdAtEpoch?: number;
}>;

export type PendingActionPreparer = (
  parsed: unknown,
  context: BusContext,
) => Promise<PendingActionPreparation | null>;

export type PendingRiskPreparer = (
  parsed: unknown,
  context: BusContext,
) => PendingRiskReservationRequest | null;

export function sameRiskRequest(
  expected: PendingRiskReservationRequest,
  actual: PendingRiskReservationRequest,
): boolean {
  return (
    JSON.stringify(freezeCanonical({ ...expected, nowEpochSeconds: 0 })) ===
    JSON.stringify(freezeCanonical({ ...actual, nowEpochSeconds: 0 }))
  );
}

export async function measurePendingRisk(
  store: PendingActionStore,
  request: PendingRiskReservationRequest,
  transaction: PendingActionTransactionContext,
): Promise<PendingRiskReservation | null> {
  try {
    return await store.measureRiskReservation(request, transaction);
  } catch (error) {
    if (error instanceof PendingRiskCapacityExceededError) return null;
    throw error;
  }
}

export function combinePendingActionPreparers(
  preparers: readonly (PendingActionPreparer | undefined)[],
): PendingActionPreparer | undefined {
  const active = preparers.filter(
    (preparer): preparer is PendingActionPreparer => preparer !== undefined,
  );
  if (active.length === 0) return undefined;
  return async (parsed, context) => {
    for (const preparer of active) {
      const result = await preparer(parsed, context);
      if (result !== null) return result;
    }
    return null;
  };
}

export function bindRiskReservation(
  preparation: PendingActionPreparation,
  reservation: PendingRiskReservation,
): PendingActionPreparation {
  if (
    typeof preparation.authority !== "object" ||
    preparation.authority === null ||
    Array.isArray(preparation.authority)
  ) {
    throw new Error("Risk-bound pending authority must be an object");
  }
  const summary =
    preparation.summary?.kind === "notification_delivery_batch"
      ? Object.freeze({
          ...preparation.summary,
          risk_window_order_count: reservation.aggregate_units,
        })
      : preparation.summary;
  const authority = Object.freeze({
    ...(preparation.authority as Readonly<Record<string, unknown>>),
    ...(summary?.kind === "notification_delivery_batch" ? { confirmation_summary: summary } : {}),
    risk_reservation: reservation,
  });
  return Object.freeze({
    authority,
    ...(summary === undefined ? {} : { summary }),
    createdAtEpoch: reservation.window_started_at_epoch + 86_400,
  });
}

export function existingNotificationSummary(
  existing: PendingAction,
): ConfirmationSummary | undefined {
  const authority = existing.authority;
  if (typeof authority !== "object" || authority === null || Array.isArray(authority)) {
    return undefined;
  }
  const parsed = NotificationDeliveryConfirmationSummarySchema.safeParse(
    (authority as Readonly<Record<string, unknown>>).confirmation_summary,
  );
  return parsed.success ? Object.freeze(parsed.data) : undefined;
}

export function pendingResponse(existing: PendingAction, summary?: ConfirmationSummary) {
  const code =
    existing.policyOutcome === "confirm"
      ? ("POLICY_CONFIRMATION_REQUIRED" as const)
      : ("POLICY_STEP_UP_REQUIRED" as const);
  return {
    ok: false as const,
    error: createCommandError(code, {
      kind: "confirmation",
      confirm_ref: existing.nonce,
      ...(summary === undefined ? {} : { summary }),
    }),
  };
}
