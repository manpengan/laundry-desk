import {
  createCommandError,
  MemberTopupConfirmationSummarySchema,
  type MemberTopupConfirmationSummary,
} from "@laundry/contracts";

import { HandlerCommandError, type HandlerContext } from "../bus/types.js";
import type {
  PendingActionPreparation,
  PendingActionPreparer,
} from "../handlers/default-chain-hooks.js";
import { matchBonusRule, type BonusMatch } from "./bonus.js";
import type { MemberRuntimeDeps } from "./handler-support.js";
import { createPgMemberStore } from "./pg-store.js";

function topupInput(parsed: unknown): Readonly<{ amount_cents: number }> {
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof Reflect.get(parsed, "amount_cents") !== "number"
  ) {
    throw new TypeError("validated member top-up input is unavailable");
  }
  return Object.freeze({ amount_cents: Reflect.get(parsed, "amount_cents") as number });
}

function transactionClient(context: Parameters<PendingActionPreparer>[1]) {
  if (context.transactionClient === undefined) {
    throw new Error("member top-up confirmation requires a transaction client");
  }
  return context.transactionClient;
}

/**
 * Resolve the exact ADR-22 bonus tier inside the first-hop tenant transaction.
 * The returned summary is both public confirmation copy and private pending-card
 * authority, so the second hop cannot silently reprice after the operator saw it.
 */
export function createMemberTopupConfirmationPreparer(
  deps: MemberRuntimeDeps,
): PendingActionPreparer {
  return async (parsed, context): Promise<PendingActionPreparation | null> => {
    if (context.definition.name !== "member.topup") return null;
    const input = topupInput(parsed);
    const store =
      deps.persistence === "sql"
        ? createPgMemberStore(transactionClient(context), context.tenant)
        : deps.store;
    const rules = await store.listBonusRules(false);
    const match = matchBonusRule(rules, input.amount_cents);
    const matchedRule =
      match.rule_id === null
        ? null
        : (rules.find((candidate) => candidate.rule_id === match.rule_id) ?? null);
    if (match.rule_id !== null && matchedRule === null) {
      throw new Error("matched member bonus rule disappeared from the confirmation snapshot");
    }

    const summary: MemberTopupConfirmationSummary = MemberTopupConfirmationSummarySchema.parse({
      kind: "member_topup",
      principal_cents: input.amount_cents,
      bonus_cents: match.bonus_cents,
      credited_cents: input.amount_cents + match.bonus_cents,
      matched_rule:
        matchedRule === null
          ? null
          : {
              rule_id: matchedRule.rule_id,
              min_topup_cents: matchedRule.min_topup_cents,
              bonus_cents: matchedRule.bonus_cents,
            },
    });
    return Object.freeze({ authority: summary, summary });
  };
}

/**
 * Recover the pending card's bonus authority for the mutation hop.
 * A confirmed member.topup without this exact snapshot is a legacy or corrupt
 * card and must fail closed instead of silently recalculating a new amount.
 */
export function requireFrozenTopupBonus(
  context: HandlerContext,
  amountCents: number,
): BonusMatch | undefined {
  if (context.request.confirmRef === undefined) return undefined;
  const parsed = MemberTopupConfirmationSummarySchema.safeParse(context.confirmationAuthority);
  if (!parsed.success || parsed.data.principal_cents !== amountCents) {
    throw new HandlerCommandError(createCommandError("POLICY_DENIED"));
  }
  return Object.freeze({
    rule_id: parsed.data.matched_rule?.rule_id ?? null,
    bonus_cents: parsed.data.bonus_cents,
  });
}
