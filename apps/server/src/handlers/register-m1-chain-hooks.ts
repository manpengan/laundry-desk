import { createDeliveryTaskConfirmationPreparer } from "../delivery-tasks/confirmation.js";
import { createDeliveryPolicyConfirmationPreparer } from "../delivery-policy/confirmation.js";
import { createFulfillmentConfirmationPreparer } from "../fulfillment/confirmation.js";
import { createMemberTopupConfirmationPreparer } from "../member/topup-confirmation.js";
import {
  createNotificationDeliveryConfirmationPreparer,
  prepareNotificationDeliveryRisk,
} from "../notification/delivery-confirmation.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import { combinePendingActionPreparers, createDefaultChainHooks } from "./default-chain-hooks.js";
import type { RegisterM1Deps } from "./register-m1-types.js";

export function createM1ChainHooks(deps: RegisterM1Deps, pendingStore: PendingActionStore) {
  return createDefaultChainHooks(
    {},
    pendingStore,
    combinePendingActionPreparers([
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
    ]),
    deps.notification === undefined ? undefined : prepareNotificationDeliveryRisk,
  );
}
