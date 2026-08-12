import { createFulfillmentConfirmationPreparer } from "../fulfillment/confirmation.js";
import { createMarketingCouponConfirmationPreparer } from "../marketing/coupon-confirmation.js";
import { createMarketingExtensionConfirmationPreparer } from "../marketing/extension-confirmation.js";
import { createMemberTopupConfirmationPreparer } from "../member/topup-confirmation.js";
import { createNotificationDeliveryConfirmationPreparer } from "../notification/delivery-confirmation.js";
import { combinePendingActionPreparers } from "./default-chain-hooks.js";
import type { RegisterM1Deps } from "./register-m1.js";
import { createStage4PendingActionPreparers } from "./stage4-registration.js";

/** Keeps the root M1 registry focused while preserving one ordered confirmation-preparer chain. */
export function createM1PendingActionPreparer(deps: RegisterM1Deps) {
  return combinePendingActionPreparers([
    deps.member === undefined || deps.order === undefined
      ? undefined
      : createMemberTopupConfirmationPreparer(deps.member),
    deps.notification === undefined
      ? undefined
      : createNotificationDeliveryConfirmationPreparer(deps.notification),
    deps.fulfillment === undefined
      ? undefined
      : createFulfillmentConfirmationPreparer(deps.fulfillment),
    ...createStage4PendingActionPreparers(deps),
    deps.marketing === undefined
      ? undefined
      : createMarketingCouponConfirmationPreparer(deps.marketing),
    deps.marketing === undefined
      ? undefined
      : createMarketingExtensionConfirmationPreparer(deps.marketing),
  ]);
}
