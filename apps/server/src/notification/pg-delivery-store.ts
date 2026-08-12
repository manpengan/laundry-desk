import type { PgPool } from "../db/pg-pool.js";
import type { NotificationDeliveryStore, NotificationWorkerStore } from "./delivery-types.js";
import { createPgNotificationClaimStore } from "./pg-delivery-claim.js";
import { createPgNotificationEvidenceStore } from "./pg-delivery-evidence.js";
import { createPgNotificationDeliveryReadStore } from "./pg-delivery-read.js";

export function createPgNotificationDeliveryStore(
  pool: PgPool,
): NotificationDeliveryStore & NotificationWorkerStore {
  return Object.freeze({
    ...createPgNotificationDeliveryReadStore(),
    ...createPgNotificationClaimStore(pool),
    ...createPgNotificationEvidenceStore(pool),
  });
}
