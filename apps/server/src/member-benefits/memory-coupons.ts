import {
  appendRecord,
  type MemoryBenefitsContext,
  type MemoryBenefitsState,
} from "./memory-state.js";
import type {
  CouponCancellationResult,
  CouponCancellationStoreInput,
  CouponRedemptionRecord,
} from "./types.js";

function reversedRedemptionIds(state: MemoryBenefitsState): ReadonlySet<string> {
  return new Set(state.couponRedemptionReversals.map((row) => row.redemption_id));
}

export function activeCouponRedemption(
  state: MemoryBenefitsState,
  assetId: string,
): CouponRedemptionRecord | undefined {
  const reversed = reversedRedemptionIds(state);
  return state.couponRedemptions.find(
    (row) => row.asset_id === assetId && !reversed.has(row.redemption_id),
  );
}

export async function reverseMemoryCouponForOrder(
  context: MemoryBenefitsContext,
  input: CouponCancellationStoreInput,
): Promise<CouponCancellationResult> {
  const state = context.read();
  const reversed = reversedRedemptionIds(state);
  const redemption = state.couponRedemptions.find(
    (row) =>
      row.store_id === input.store_id &&
      row.order_id === input.order_id &&
      !reversed.has(row.redemption_id),
  );
  if (redemption === undefined) {
    return Object.freeze({ changed: false, asset_id: null, reversal_id: null });
  }
  const reversalId = context.newId();
  context.write(
    Object.freeze({
      ...state,
      couponRedemptionReversals: appendRecord(
        state.couponRedemptionReversals,
        Object.freeze({
          reversal_id: reversalId,
          redemption_id: redemption.redemption_id,
          asset_id: redemption.asset_id,
          order_id: redemption.order_id,
          staff_id: input.staff_id,
          at: input.at,
          reason: input.reason,
        }),
      ),
    }),
  );
  return Object.freeze({
    changed: true,
    asset_id: redemption.asset_id,
    reversal_id: reversalId,
  });
}
