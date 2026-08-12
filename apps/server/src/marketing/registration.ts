import type { MutableQueryRegistry } from "../bus/query-registry.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import { createMarketingHandlers } from "./handlers.js";
import type { MarketingHandlerDeps } from "./types.js";

export function registerMarketingCommands(
  registry: MutableCommandRegistry,
  deps: MarketingHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  const handlers = createMarketingHandlers(deps);
  registry.registerHandler("marketing.campaign.set", handlers["marketing.campaign.set"]);
  registry.registerHandler(
    "marketing.campaign.audience.freeze",
    handlers["marketing.campaign.audience.freeze"],
  );
  registry.registerHandler(
    "marketing.campaign.coupons.issue",
    handlers["marketing.campaign.coupons.issue"]!,
  );
  registry.registerHandler(
    "marketing.coupon.redemption.reverse",
    handlers["marketing.coupon.redemption.reverse"]!,
  );
  return Object.freeze([
    "marketing.campaign.set",
    "marketing.campaign.audience.freeze",
    "marketing.campaign.coupons.issue",
    "marketing.coupon.redemption.reverse",
  ]);
}

export function registerMarketingQueries(
  registry: MutableQueryRegistry,
  deps: MarketingHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  const handlers = createMarketingHandlers(deps);
  registry.registerHandler("marketing.campaigns.list", handlers["marketing.campaigns.list"]);
  registry.registerHandler("marketing.campaign.get", handlers["marketing.campaign.get"]);
  registry.registerHandler(
    "marketing.campaign.audience.preview",
    handlers["marketing.campaign.audience.preview"],
  );
  registry.registerHandler(
    "marketing.campaign.coupons.preview",
    handlers["marketing.campaign.coupons.preview"]!,
  );
  registry.registerHandler(
    "marketing.campaign.coupon_batch.get",
    handlers["marketing.campaign.coupon_batch.get"]!,
  );
  return Object.freeze([
    "marketing.campaigns.list",
    "marketing.campaign.get",
    "marketing.campaign.audience.preview",
    "marketing.campaign.coupons.preview",
    "marketing.campaign.coupon_batch.get",
  ]);
}
