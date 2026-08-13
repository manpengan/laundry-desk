import { createHash } from "node:crypto";

import type { MarketingAudienceRule } from "@laundry/contracts";

import type { MemoryAudienceCustomer } from "./types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function audienceDigest(
  campaignId: string,
  campaignVersion: number,
  audienceRuleSha256: string,
  customerIds: readonly string[],
): string {
  return sha256Canonical({
    campaign_id: campaignId,
    campaign_version: campaignVersion,
    audience_rule_sha256: audienceRuleSha256,
    customer_ids: [...customerIds].sort(),
  });
}

function businessDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function matches(rule: MarketingAudienceRule, customer: MemoryAudienceCustomer, at: Date): boolean {
  if (
    rule.customer_age.kind === "within_days" &&
    at.getTime() - customer.createdAt.getTime() > rule.customer_age.days * 86_400_000
  ) {
    return false;
  }
  const lastOrderAt = customer.lastOrderAt?.getTime() ?? null;
  if (rule.order_activity.kind === "none" && lastOrderAt !== null) return false;
  if (
    rule.order_activity.kind === "within_days" &&
    (lastOrderAt === null || at.getTime() - lastOrderAt > rule.order_activity.days * 86_400_000)
  ) {
    return false;
  }
  const currentTier =
    customer.activeMember &&
    customer.tierId !== null &&
    customer.tierValidUntil !== null &&
    customer.tierValidUntil >= businessDate(at);
  if (rule.membership.kind === "member" && !customer.activeMember) return false;
  if (rule.membership.kind === "non_member" && customer.activeMember) return false;
  return (
    rule.membership.kind !== "tiers" ||
    (currentTier && rule.membership.tier_ids.includes(customer.tierId ?? ""))
  );
}

export function evaluateMemoryAudience(
  customers: readonly MemoryAudienceCustomer[],
  rule: MarketingAudienceRule,
  recipientLimit: number,
  at: Date,
): Readonly<{ customerIds: readonly string[]; matchedCount: number }> {
  const matched = customers
    .filter((customer) => matches(rule, customer, at))
    .map((customer) => customer.customerId)
    .sort();
  return Object.freeze({
    customerIds: Object.freeze(matched.slice(0, recipientLimit)),
    matchedCount: matched.length,
  });
}
