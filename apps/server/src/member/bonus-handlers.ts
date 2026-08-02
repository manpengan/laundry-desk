/**
 * Top-up bonus tier maintenance (ADR-22 §2).
 *
 * Separate from the money path: a tier is configuration that decides future
 * grants, while the ledger handlers move money that already exists.
 */

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { asRecord, requireNonNegativeInteger, requireString } from "../order/server-pricing.js";
import {
  openBusinessDate,
  optionalNote,
  refusalError,
  requirePermission,
  resolveStore,
  type MemberHandlerDeps,
} from "./handler-support.js";

export function createMemberBonusHandlers(
  deps: MemberHandlerDeps,
): Readonly<Record<"member.bonus_rule.upsert" | "member.bonus_rules.list", CommandHandler>> {
  const bonusRuleUpsert: CommandHandler = async (context): Promise<HandlerOutcome> => {
    // Not `catalog_write`: changing a tier changes how much money the shop gives
    // away, which is not the same risk as repricing one service (ADR-22 §2.3).
    requirePermission(context.actor.permissions, "member_rule_write");
    const input = asRecord(context.parsed);
    const outcome = await resolveStore(deps, context).upsertBonusRule({
      rule_id: typeof input.rule_id === "string" ? input.rule_id : null,
      min_topup_cents: requireNonNegativeInteger(input.min_topup_cents),
      bonus_cents: requireNonNegativeInteger(input.bonus_cents),
      status: requireString(input.status) === "retired" ? "retired" : "active",
      staff_id: context.actor.staffId,
      at: (await openBusinessDate(deps, context)).now,
      note: optionalNote(input),
    });
    if (!outcome.ok) throw refusalError(outcome.reason);

    return Object.freeze({
      result: Object.freeze({
        rule_id: outcome.value.rule_id,
        min_topup_cents: outcome.value.min_topup_cents,
        bonus_cents: outcome.value.bonus_cents,
        status: outcome.value.status,
      }),
      audit: Object.freeze({
        entity: "member_bonus_rules",
        entityId: outcome.value.rule_id,
        afterJson: JSON.stringify({
          min_topup_cents: outcome.value.min_topup_cents,
          bonus_cents: outcome.value.bonus_cents,
          status: outcome.value.status,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "member.bonus_rule_changed",
          payload: Object.freeze({ rule_id: outcome.value.rule_id }),
        }),
      ]),
    });
  };

  const bonusRulesList: CommandHandler = async (context): Promise<HandlerOutcome> => {
    requirePermission(context.actor.permissions, "customer_read");
    const input = asRecord(context.parsed);
    const rules = await resolveStore(deps, context).listBonusRules(input.include_retired === true);
    return Object.freeze({
      result: Object.freeze({
        rules: Object.freeze(
          rules.map((rule) =>
            Object.freeze({
              rule_id: rule.rule_id,
              min_topup_cents: rule.min_topup_cents,
              bonus_cents: rule.bonus_cents,
              status: rule.status,
              updated_at: rule.updated_at,
              note: rule.note,
            }),
          ),
        ),
      }),
    });
  };

  return Object.freeze({
    "member.bonus_rule.upsert": bonusRuleUpsert,
    "member.bonus_rules.list": bonusRulesList,
  });
}
