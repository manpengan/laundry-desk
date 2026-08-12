import type { AuthorizedSession } from "../auth/session-view.js";
import { LOCAL_PROFILE } from "../local/profile.js";

const OWNER_CLOUD_COMMANDS: ReadonlySet<string> = new Set([
  "accounting.report.export",
  "staff.access.set",
  "staff.create",
  "staff.credentials.reset",
  "store.profile.set",
  "marketing.campaign.set",
  "marketing.campaign.audience.freeze",
  "marketing.campaign.coupons.issue",
  "marketing.coupon.redemption.reverse",
  "marketing.referral.reward.issue",
  "marketing.group_buy.voucher.register",
  "marketing.group_buy.voucher.redeem",
]);

const OWNER_CLOUD_QUERIES: ReadonlySet<string> = new Set([
  "accounting.report.get",
  "reporting.owner_dashboard.get",
  "reporting.owner_dashboard.drilldown",
  "reporting.owner_portfolio.get",
  "staff.access.list",
  "store.authorized.list",
  "member.benefit_catalog.get",
  "marketing.campaigns.list",
  "marketing.campaign.get",
  "marketing.campaign.audience.preview",
  "marketing.campaign.coupons.preview",
  "marketing.campaign.coupon_batch.get",
]);

export type RuntimeBusSurface = "command" | "query";

/**
 * Most counter dependencies are still constructed for the commissioned local
 * store. Sessions for another PostgreSQL store therefore receive only the
 * Stage 3.2 Owner surface until those dependencies become request-scoped.
 */
export function isConfiguredRuntimeTenant(resolved: AuthorizedSession): boolean {
  return (
    resolved.session.org_id === LOCAL_PROFILE.orgId &&
    resolved.session.store_id === LOCAL_PROFILE.storeId
  );
}

export function isRuntimeBusOperationAvailable(
  resolved: AuthorizedSession,
  surface: RuntimeBusSurface,
  name: string,
): boolean {
  if (isConfiguredRuntimeTenant(resolved)) return true;
  return surface === "command" ? OWNER_CLOUD_COMMANDS.has(name) : OWNER_CLOUD_QUERIES.has(name);
}
