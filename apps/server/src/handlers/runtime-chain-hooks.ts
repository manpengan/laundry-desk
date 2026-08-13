import type { ChainPortHooks } from "../bus/chain-adapter.js";
import { createFulfillmentConfirmationPreparer } from "../fulfillment/confirmation.js";
import { createMemberTopupConfirmationPreparer } from "../member/topup-confirmation.js";
import {
  createNotificationDeliveryConfirmationPreparer,
  prepareNotificationDeliveryRisk,
} from "../notification/delivery-confirmation.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import type { RegisterM1Deps } from "./register-m1.js";
import { combinePendingActionPreparers, createDefaultChainHooks } from "./default-chain-hooks.js";

export function createRuntimeChainHooks(
  deps: RegisterM1Deps,
  pendingStore: PendingActionStore,
): ChainPortHooks {
  return createDefaultChainHooks(
    {},
    pendingStore,
    combinePendingActionPreparers([
      deps.member === undefined || deps.order === undefined
        ? undefined
        : createMemberTopupConfirmationPreparer(deps.member),
      deps.notification === undefined
        ? undefined
        : createNotificationDeliveryConfirmationPreparer(deps.notification),
      deps.fulfillment === undefined
        ? undefined
        : createFulfillmentConfirmationPreparer(deps.fulfillment),
    ]),
    deps.notification === undefined ? undefined : prepareNotificationDeliveryRisk,
  );
}
