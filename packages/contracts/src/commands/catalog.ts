import type { CommandDefinition, QueryDefinition } from "../registry/definitions.js";
import { IDENTITY_COMMANDS, IDENTITY_COMMAND_NAMES } from "./identity.js";
import {
  CATALOG_ADMIN_QUERY_DEFINITIONS,
  CATALOG_ADMIN_QUERY_NAMES,
  CATALOG_COMMAND_DEFINITIONS,
  CATALOG_COMMAND_NAMES,
  CATALOG_SKELETON_DEFINITIONS,
  CATALOG_SKELETON_QUERY_NAMES,
} from "./catalog-items.js";
import {
  M2_CUSTOMER_COMMAND_DEFINITIONS,
  M2_CUSTOMER_COMMAND_NAMES,
  M2_CUSTOMER_QUERY_DEFINITIONS,
  M2_CUSTOMER_QUERY_NAMES,
  customerDuplicatesQuery,
  customerSearchQuery,
} from "./customer.js";
import {
  CUSTOMER_PROFILE_COMMANDS,
  CUSTOMER_PROFILE_COMMAND_NAMES,
  CUSTOMER_PROFILE_QUERIES,
  CUSTOMER_PROFILE_QUERY_NAMES,
} from "./customer-profile.js";
import {
  M3_FULFILLMENT_COMMAND_DEFINITIONS,
  M3_FULFILLMENT_QUERY_DEFINITIONS,
} from "./fulfillment.js";
import { FACTORY_HANDOFF_COMMANDS, FACTORY_HANDOFF_QUERIES } from "./factory-handoff.js";
import { ORDER_COMMANDS, ORDER_COMMAND_NAMES, ORDER_QUERIES, ORDER_QUERY_NAMES } from "./order.js";
import {
  PAYMENT_COMMANDS,
  PAYMENT_COMMAND_NAMES,
  PAYMENT_QUERIES,
  PAYMENT_QUERY_NAMES,
} from "./payment.js";
import {
  PRICING_COMMANDS,
  PRICING_COMMAND_NAMES,
  PRICING_QUERIES,
  PRICING_QUERY_NAMES,
} from "./pricing.js";
import { ACCOUNTING_COMMANDS, ACCOUNTING_QUERIES } from "./accounting.js";
import { REPORTING_QUERIES } from "./reporting.js";
import { EDGE_CONFLICT_COMMANDS } from "./edge-conflict.js";
import { RECONCILIATION_COMMANDS, RECONCILIATION_QUERIES } from "./reconciliation.js";
import { PLATFORM_COMMANDS, PLATFORM_DEFINITIONS, PLATFORM_QUERIES } from "./platform.js";
import { MEMBER_COMMANDS, MEMBER_QUERIES } from "./member.js";
import { MEMBER_BENEFIT_COMMANDS, MEMBER_BENEFIT_QUERIES } from "./member-benefits.js";
import { MEMBER_LIFECYCLE_COMMANDS } from "./member-lifecycle.js";
import { MARKETING_COMMANDS, MARKETING_QUERIES } from "./marketing.js";
import { MARKETING_COUPON_COMMANDS, MARKETING_COUPON_QUERIES } from "./marketing-coupons.js";
import { MARKETING_EXTENSION_COMMANDS } from "./marketing-extensions.js";
import {
  CUSTOMER_SELF_SERVICE_QUERIES,
  CUSTOMER_SELF_SERVICE_QUERY_NAMES,
} from "./customer-self-service.js";
import { NOTIFICATION_COMMANDS, NOTIFICATION_QUERIES } from "./notification.js";
import {
  NOTIFICATION_DELIVERY_COMMANDS,
  NOTIFICATION_DELIVERY_QUERIES,
} from "./notification-delivery.js";
import { STAFF_COMMANDS, STAFF_QUERIES } from "./staff.js";
import { STORE_MANAGEMENT_COMMANDS, STORE_MANAGEMENT_QUERIES } from "./store-management.js";
import {
  M2_PRINT_COMMAND_DEFINITIONS,
  M2_PRINT_COMMAND_NAMES,
  M2_PRINT_QUERY_DEFINITIONS,
  M2_PRINT_QUERY_NAMES,
} from "./print.js";
import {
  M2_SHIFT_COMMAND_DEFINITIONS,
  M2_SHIFT_COMMAND_NAMES,
  M2_SHIFT_QUERY_DEFINITIONS,
  M2_SHIFT_QUERY_NAMES,
} from "./shift.js";
import {
  M3_PHOTO_COMMAND_DEFINITIONS,
  M3_PHOTO_COMMAND_NAMES,
  M3_PHOTO_QUERY_DEFINITIONS,
  M3_PHOTO_QUERY_NAMES,
} from "./photo.js";
import { M2_STATS_QUERY_DEFINITIONS, M2_STATS_QUERY_NAMES } from "./stats.js";
import type { z } from "zod";

/** M1 first-wave registered definitions (A6). OpenAPI snapshot remains M1-only. */
export const M1_FIRST_WAVE_DEFINITIONS: readonly (
  CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>
)[] = Object.freeze([...IDENTITY_COMMANDS, ...PLATFORM_DEFINITIONS]);

export const M1_FIRST_WAVE_COMMAND_NAMES = Object.freeze([
  ...IDENTITY_COMMAND_NAMES,
  ...PLATFORM_COMMANDS.map((command) => command.name),
] as const);

export const M1_FIRST_WAVE_QUERY_NAMES = Object.freeze(PLATFORM_QUERIES.map((query) => query.name));

/**
 * M2/M3 skeleton commands (order + print + customer + shift + photo register).
 * Not yet in OpenAPI freeze snapshot; server loads via createM1CommandRegistry([...M1, ...M2/M3]).
 */
export const M2_SKELETON_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] = Object.freeze([
  ...ORDER_COMMANDS,
  ...PAYMENT_COMMANDS,
  ...PRICING_COMMANDS,
  ...ACCOUNTING_COMMANDS,
  ...RECONCILIATION_COMMANDS,
  ...EDGE_CONFLICT_COMMANDS,
  ...M2_PRINT_COMMAND_DEFINITIONS,
  ...M2_CUSTOMER_COMMAND_DEFINITIONS,
  ...CUSTOMER_PROFILE_COMMANDS,
  ...M2_SHIFT_COMMAND_DEFINITIONS,
  ...M3_PHOTO_COMMAND_DEFINITIONS,
  ...CATALOG_COMMAND_DEFINITIONS,
  ...M3_FULFILLMENT_COMMAND_DEFINITIONS,
  ...FACTORY_HANDOFF_COMMANDS,
  ...STAFF_COMMANDS,
  ...STORE_MANAGEMENT_COMMANDS,
  ...MEMBER_COMMANDS,
  ...MEMBER_LIFECYCLE_COMMANDS,
  ...MEMBER_BENEFIT_COMMANDS,
  ...NOTIFICATION_COMMANDS,
  ...NOTIFICATION_DELIVERY_COMMANDS,
  ...MARKETING_COMMANDS,
  ...MARKETING_COUPON_COMMANDS,
  ...MARKETING_EXTENSION_COMMANDS,
]);

export const M2_SKELETON_COMMAND_NAMES = Object.freeze([
  ...M2_CUSTOMER_COMMAND_NAMES,
  ...CUSTOMER_PROFILE_COMMAND_NAMES,
  ...ORDER_COMMAND_NAMES,
  ...PAYMENT_COMMAND_NAMES,
  ...PRICING_COMMAND_NAMES,
  "accounting.report.export",
  "reconciliation.export",
  "edge.conflict.discard",
  ...M2_PRINT_COMMAND_NAMES,
  ...M2_SHIFT_COMMAND_NAMES,
  ...M3_PHOTO_COMMAND_NAMES,
  ...CATALOG_COMMAND_NAMES,
  "garment.transition",
  "garment.bulk_transition",
  "garment.rack.assign",
  "garment.rework",
  "garment.incident.record",
  "garment.mark_lost",
  "fulfillment.batch.create",
  "fulfillment.batch.cancel",
  "fulfillment.handoff.checkpoint.record",
  "fulfillment.handoff.discrepancy.resolve",
  "fulfillment.quality_check.record",
  "staff.access.set",
  "staff.create",
  "staff.credentials.reset",
  "store.profile.set",
  "member.account.open",
  "member.topup",
  "member.balance.pay",
  "member.bonus_rule.upsert",
  "member.refund",
  "member.account.freeze",
  "member.account.unfreeze",
  "member.account.close",
  // ADR-41: virtual tier and append-only benefit assets. All calculations and
  // expiry decisions remain server-authoritative and online-only.
  "member.benefit_definition.upsert",
  "member.membership.set",
  "member.points.earn",
  "member.points.redeem",
  "member.asset.grant",
  "member.asset.consume",
  "notification.manual_list.create",
  "notification.delivery_batch.enqueue",
  "marketing.campaign.set",
  "marketing.campaign.audience.freeze",
  "marketing.campaign.coupons.issue",
  "marketing.coupon.redemption.reverse",
  "marketing.referral.reward.issue",
  "marketing.group_buy.voucher.register",
  "marketing.group_buy.voucher.redeem",
] as const) as readonly [
  "customer.upsert",
  "customer.update",
  "customer.merge",
  "customer.privacy.export",
  "customer.anonymize",
  "customer.profile.set",
  "customer.discount_policy.set",
  "order.receive",
  "order.hold",
  "order.cancel",
  "order.pickup",
  "payment.collect",
  "payment.repay",
  "payment.refund",
  "pricing.policy.set",
  "accounting.report.export",
  "reconciliation.export",
  "edge.conflict.discard",
  "print.ticket.enqueue",
  "print.ticket.process",
  "print.ticket.retry",
  "print.ticket.reprint",
  "shift.close",
  "photo.register",
  "photo.delete",
  "catalog.item.upsert",
  "catalog.items.reorder",
  "garment.transition",
  "garment.bulk_transition",
  "garment.rack.assign",
  "garment.rework",
  "garment.incident.record",
  "garment.mark_lost",
  "fulfillment.batch.create",
  "fulfillment.batch.cancel",
  "fulfillment.handoff.checkpoint.record",
  "fulfillment.handoff.discrepancy.resolve",
  "fulfillment.quality_check.record",
  "staff.access.set",
  "staff.create",
  "staff.credentials.reset",
  "store.profile.set",
  "member.account.open",
  "member.topup",
  "member.balance.pay",
  "member.bonus_rule.upsert",
  "member.refund",
  "member.account.freeze",
  "member.account.unfreeze",
  "member.account.close",
  "member.benefit_definition.upsert",
  "member.membership.set",
  "member.points.earn",
  "member.points.redeem",
  "member.asset.grant",
  "member.asset.consume",
  "notification.manual_list.create",
  "notification.delivery_batch.enqueue",
  "marketing.campaign.set",
  "marketing.campaign.audience.freeze",
  "marketing.campaign.coupons.issue",
  "marketing.coupon.redemption.reverse",
  "marketing.referral.reward.issue",
  "marketing.group_buy.voucher.register",
  "marketing.group_buy.voucher.redeem",
];

/**
 * M2 order read queries (order.get + order.list for counter UX).
 * Not in OpenAPI freeze; load via query registry separately from commands.
 */
export const M2_ORDER_QUERY_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...ORDER_QUERIES,
]);

export const M2_ORDER_QUERY_NAMES = ORDER_QUERY_NAMES;

/**
 * M2 catalog item queries (price list). Separate from order commands so
 * command registry and query registry can load independently.
 */
export const M2_CATALOG_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...CATALOG_SKELETON_DEFINITIONS,
  ...CATALOG_ADMIN_QUERY_DEFINITIONS,
]);

/** ADR-15: the single unfrozen catalog write command. Never in the AI projection. */
export const M2_CATALOG_COMMAND_DEFINITIONS: readonly CommandDefinition<z.ZodObject>[] =
  Object.freeze([...CATALOG_COMMAND_DEFINITIONS]);

export const M2_CATALOG_QUERY_NAMES = Object.freeze([
  ...CATALOG_SKELETON_QUERY_NAMES,
  ...CATALOG_ADMIN_QUERY_NAMES,
] as const);

/** Frozen v0.2 M2 contract surface consumed by server, Web and Edge. */
export const M2_CONTRACT_COMMAND_NAMES = M2_SKELETON_COMMAND_NAMES;

export const M2_CONTRACT_QUERY_NAMES = Object.freeze([
  ...CATALOG_SKELETON_QUERY_NAMES,
  ...CATALOG_ADMIN_QUERY_NAMES,
  ...M2_CUSTOMER_QUERY_NAMES,
  ...CUSTOMER_PROFILE_QUERY_NAMES,
  ...ORDER_QUERY_NAMES,
  ...PRICING_QUERY_NAMES,
  ...PAYMENT_QUERY_NAMES,
  ...M2_PRINT_QUERY_NAMES,
  ...M2_STATS_QUERY_NAMES,
  ...M2_SHIFT_QUERY_NAMES,
  ...M3_PHOTO_QUERY_NAMES,
  "accounting.report.get",
  "reporting.owner_dashboard.get",
  "reporting.owner_dashboard.drilldown",
  "reporting.owner_portfolio.get",
  "reconciliation.day.get",
  "fulfillment.workbench",
  "fulfillment.batches.list",
  "fulfillment.batch.get",
  "staff.access.list",
  "store.authorized.list",
  "member.account.get",
  "member.bonus_rules.list",
  "member.benefit_catalog.get",
  "member.benefits.get",
  "notification.pickup_reminders.list",
  "notification.delivery.capability.get",
  "notification.delivery_batches.list",
  "notification.delivery_batch.get",
  "marketing.campaigns.list",
  "marketing.campaign.get",
  "marketing.campaign.audience.preview",
  "marketing.campaign.coupons.preview",
  "marketing.campaign.coupon_batch.get",
  ...CUSTOMER_SELF_SERVICE_QUERY_NAMES,
] as const);

export const M2_CONTRACT_DEFINITIONS: readonly (
  CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>
)[] = Object.freeze([
  ...M2_SKELETON_DEFINITIONS,
  ...CATALOG_SKELETON_DEFINITIONS,
  ...CATALOG_ADMIN_QUERY_DEFINITIONS,
  ...M2_CUSTOMER_QUERY_DEFINITIONS,
  ...CUSTOMER_PROFILE_QUERIES,
  ...ORDER_QUERIES,
  ...PRICING_QUERIES,
  ...PAYMENT_QUERIES,
  ...M2_PRINT_QUERY_DEFINITIONS,
  ...M2_STATS_QUERY_DEFINITIONS,
  ...M2_SHIFT_QUERY_DEFINITIONS,
  ...M3_PHOTO_QUERY_DEFINITIONS,
  ...ACCOUNTING_QUERIES,
  ...REPORTING_QUERIES,
  ...RECONCILIATION_QUERIES,
  ...M3_FULFILLMENT_QUERY_DEFINITIONS,
  ...FACTORY_HANDOFF_QUERIES,
  ...STAFF_QUERIES,
  ...STORE_MANAGEMENT_QUERIES,
  ...MEMBER_QUERIES,
  ...MEMBER_BENEFIT_QUERIES,
  ...NOTIFICATION_QUERIES,
  ...NOTIFICATION_DELIVERY_QUERIES,
  ...MARKETING_QUERIES,
  ...MARKETING_COUPON_QUERIES,
  ...CUSTOMER_SELF_SERVICE_QUERIES,
]);

/** M2 AI presets are read-only: no command is exposed to the tool projection. */
export const M2_READ_ONLY_AI_DEFINITIONS: readonly QueryDefinition<z.ZodObject>[] = Object.freeze([
  ...CATALOG_SKELETON_DEFINITIONS,
  // ADR-42: explicit safe allowlist. Full profile/detail/privacy queries are
  // intentionally PII-bearing and must never enter the AI tool projection.
  customerSearchQuery,
  customerDuplicatesQuery,
  ...ORDER_QUERIES,
  ...M2_PRINT_QUERY_DEFINITIONS,
  ...M2_STATS_QUERY_DEFINITIONS,
  ...M2_SHIFT_QUERY_DEFINITIONS,
  ...M3_PHOTO_QUERY_DEFINITIONS,
  ...M3_FULFILLMENT_QUERY_DEFINITIONS,
]);

export * from "./catalog-exports.js";
