import type {
  CustomerPortalProfileResult,
  CustomerPortalProfileUpdateInput,
} from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";
import { withPortalTransaction } from "./pg-context.js";
import { readPortalProfile } from "./pg-projections.js";
import {
  CustomerPortalProfileConflictError,
  CustomerPortalSessionInvalidError,
  type CustomerPortalSessionIdentity,
} from "./types.js";

const pgFailure = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

export async function updatePortalProfile(
  pool: PgPool,
  identity: CustomerPortalSessionIdentity,
  sessionHash: string,
  input: CustomerPortalProfileUpdateInput,
): Promise<CustomerPortalProfileResult> {
  try {
    const result = await withPortalTransaction(
      pool,
      identity,
      sessionHash,
      null,
      async (client) => {
        await client.query(
          `SELECT version, preferred_contact, address_count
           FROM customer_portal_profile_update(
             $1::uuid, $2::text, $3::text, $4::integer, $5::text, $6::jsonb
           )`,
          [
            identity.sessionId,
            sessionHash,
            identity.authorityHash,
            input.expected_version,
            input.preferred_contact,
            JSON.stringify(input.addresses),
          ],
        );
        return readPortalProfile(client);
      },
    );
    if (result === null) throw new CustomerPortalSessionInvalidError();
    return result;
  } catch (error) {
    if (pgFailure(error, "40001")) throw new CustomerPortalProfileConflictError();
    if (pgFailure(error, "28000")) throw new CustomerPortalSessionInvalidError();
    throw error;
  }
}
