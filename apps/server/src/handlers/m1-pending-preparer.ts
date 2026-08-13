import { createFulfillmentConfirmationPreparer } from "../fulfillment/confirmation.js";
import { createDeliveryEvidenceConfirmationPreparer } from "../delivery-evidence/confirmation.js";
import { createDeliveryPolicyConfirmationPreparer } from "../delivery-policy/confirmation.js";
import { createDeliveryTaskConfirmationPreparer } from "../delivery-tasks/confirmation.js";
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
    deps.deliveryPolicy === undefined ? undefined : createDeliveryPolicyConfirmationPreparer(),
    deps.member === undefined || deps.order === undefined
      ? undefined
      : createMemberTopupConfirmationPreparer(deps.member),
    deps.notification === undefined
      ? undefined
      : createNotificationDeliveryConfirmationPreparer(deps.notification),
    deps.fulfillment === undefined
      ? undefined
      : createFulfillmentConfirmationPreparer(deps.fulfillment),
    deps.deliveryTasks === undefined
      ? undefined
      : createDeliveryTaskConfirmationPreparer(deps.deliveryTasks),
    deps.deliveryEvidence === undefined
      ? undefined
      : createDeliveryEvidenceConfirmationPreparer(
          deps.deliveryEvidence.store,
          async (orgId, storeId, orderId) =>
            (await deps.deliveryEvidence?.orders.get(orgId, storeId, orderId))?.customer_id ?? null,
        ),
    ...createStage4PendingActionPreparers(deps),
    deps.marketing === undefined
      ? undefined
      : createMarketingCouponConfirmationPreparer(deps.marketing),
    deps.marketing === undefined
      ? undefined
      : createMarketingExtensionConfirmationPreparer(deps.marketing),
  ]);
}
