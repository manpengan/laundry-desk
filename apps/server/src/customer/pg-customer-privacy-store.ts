import type { PgPool } from "../db/pg-pool.js";
import { withOrgGucOrCurrent, withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import {
  anonymizePgCustomer,
  exportPgPrivacy,
  readPgPrivacyEvents,
  readPgPrivacyStatus,
} from "./pg-customer-privacy.js";
import type { CustomerStore } from "./types.js";

type CustomerPrivacyOperations = Pick<
  CustomerStore,
  "privacyStatus" | "listPrivacyEvents" | "exportPrivacy" | "anonymize"
>;

export function createPgCustomerPrivacyOperations(
  pool: PgPool,
  orgId: string,
): CustomerPrivacyOperations {
  return Object.freeze({
    privacyStatus: async (customerId, storeId, staffId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId, staffId }, (client) =>
        readPgPrivacyStatus(client, customerId),
      ),
    listPrivacyEvents: async (customerId, limit) =>
      withOrgGucOrCurrent(pool, { orgId }, (client) =>
        readPgPrivacyEvents(client, orgId, customerId, limit),
      ),
    exportPrivacy: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId, storeId: input.store_id, staffId: input.staff_id },
        (client) => exportPgPrivacy(client, input),
      ),
    anonymize: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId, storeId: input.store_id, staffId: input.staff_id },
        (client) => anonymizePgCustomer(client, input),
      ),
  });
}
