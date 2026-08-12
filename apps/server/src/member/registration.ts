import type { MutableCommandRegistry } from "../bus/registry.js";
import type { MutableQueryRegistry } from "../bus/query-registry.js";
import { createMemberBenefitsHandlers } from "../member-benefits/handlers.js";
import type { MemberBenefitsRuntimeDeps } from "../member-benefits/types.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import { createMemberHandlers, type MemberRuntimeDeps } from "./handlers.js";

export type MemberRegistrationDeps = Readonly<{
  member?: MemberRuntimeDeps;
  memberBenefits?: MemberBenefitsRuntimeDeps;
  order?: OrderHandlerDeps;
}>;

export function registerCommands(
  registry: MutableCommandRegistry,
  deps: MemberRegistrationDeps,
): readonly string[] {
  if (deps.order === undefined) return Object.freeze([]);
  const names: string[] = [];
  if (deps.member !== undefined) {
    const handlers = createMemberHandlers({ ...deps.member, order: deps.order });
    for (const name of [
      "member.account.open",
      "member.topup",
      "member.balance.pay",
      "member.bonus_rule.upsert",
      "member.refund",
      "member.account.freeze",
      "member.account.unfreeze",
      "member.account.close",
    ]) {
      registry.registerHandler(name, handlers[name as keyof typeof handlers]);
      names.push(name);
    }
  }
  if (deps.memberBenefits !== undefined) {
    const handlers = createMemberBenefitsHandlers({ ...deps.memberBenefits, order: deps.order });
    for (const name of [
      "member.benefit_definition.upsert",
      "member.membership.set",
      "member.points.earn",
      "member.points.redeem",
      "member.asset.grant",
      "member.asset.consume",
    ]) {
      registry.registerHandler(name, handlers[name]!);
      names.push(name);
    }
  }
  return Object.freeze(names);
}

export function registerQueries(
  registry: MutableQueryRegistry,
  deps: MemberRegistrationDeps,
): readonly string[] {
  if (deps.order === undefined) return Object.freeze([]);
  const names: string[] = [];
  if (deps.member !== undefined) {
    const handlers = createMemberHandlers({ ...deps.member, order: deps.order });
    registry.registerHandler("member.account.get", handlers["member.account.get"]);
    registry.registerHandler("member.bonus_rules.list", handlers["member.bonus_rules.list"]);
    names.push("member.account.get", "member.bonus_rules.list");
  }
  if (deps.memberBenefits !== undefined) {
    const handlers = createMemberBenefitsHandlers({ ...deps.memberBenefits, order: deps.order });
    registry.registerHandler("member.benefit_catalog.get", handlers["member.benefit_catalog.get"]!);
    registry.registerHandler("member.benefits.get", handlers["member.benefits.get"]!);
    names.push("member.benefit_catalog.get", "member.benefits.get");
  }
  return Object.freeze(names);
}
