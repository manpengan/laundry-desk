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
  return Object.freeze(["marketing.campaign.set", "marketing.campaign.audience.freeze"]);
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
  return Object.freeze([
    "marketing.campaigns.list",
    "marketing.campaign.get",
    "marketing.campaign.audience.preview",
  ]);
}
