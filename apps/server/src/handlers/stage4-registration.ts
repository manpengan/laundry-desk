import type { MutableQueryRegistry } from "../bus/query-registry.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import { createMarketingCampaignConfirmationPreparer } from "../marketing/confirmation.js";
import type { MarketingHandlerDeps } from "../marketing/types.js";
import * as marketingRegistration from "../marketing/registration.js";
import type { NotificationHandlerDeps } from "../notification/types.js";
import * as notificationRegistration from "../notification/registration.js";
import type { PendingActionPreparer } from "./default-chain-hooks.js";

export type Stage4RegistrationDeps = Readonly<{
  notification?: NotificationHandlerDeps;
  marketing?: MarketingHandlerDeps;
}>;

export function registerStage4Commands(
  registry: MutableCommandRegistry,
  deps: Stage4RegistrationDeps,
): readonly string[] {
  return Object.freeze([
    ...notificationRegistration.registerNotificationCommands(registry, deps.notification),
    ...marketingRegistration.registerMarketingCommands(registry, deps.marketing),
  ]);
}

export function registerStage4Queries(
  registry: MutableQueryRegistry,
  deps: Stage4RegistrationDeps,
): readonly string[] {
  return Object.freeze([
    ...notificationRegistration.registerNotificationQueries(registry, deps.notification),
    ...marketingRegistration.registerMarketingQueries(registry, deps.marketing),
  ]);
}

export function createStage4PendingActionPreparers(
  deps: Stage4RegistrationDeps,
): readonly (PendingActionPreparer | undefined)[] {
  return Object.freeze([
    deps.marketing === undefined
      ? undefined
      : createMarketingCampaignConfirmationPreparer(deps.marketing),
  ]);
}
