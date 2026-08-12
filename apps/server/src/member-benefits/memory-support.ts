import type { MemberAccountRecord } from "../member/types.js";
import type { MemoryBenefitsContext } from "./memory-state.js";
import type { MemberBenefitOutcome, MemberBenefitRejectReason } from "./types.js";

export const rejectBenefit = <TValue>(
  reason: MemberBenefitRejectReason,
): MemberBenefitOutcome<TValue> => Object.freeze({ ok: false as const, reason });

export async function requireActiveAccount(
  context: MemoryBenefitsContext,
  accountId: string,
): Promise<MemberBenefitOutcome<MemberAccountRecord>> {
  const view = await context.memberStore.getById(accountId, 0);
  if (view === null) return rejectBenefit("account_not_found");
  if (view.account.status === "frozen") return rejectBenefit("account_frozen");
  if (view.account.status === "closed") return rejectBenefit("account_closed");
  return Object.freeze({ ok: true as const, value: view.account });
}
