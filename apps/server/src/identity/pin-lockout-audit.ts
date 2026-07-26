import { randomUUID } from "node:crypto";

import { writeAudit } from "../audit/write-audit.js";
import type { PgPoolClient } from "../db/pg-pool.js";
import { epochToDate } from "./pg-store-mappers.js";
import type { Uuid } from "./types.js";

const LOCKOUT_AFTER_JSON = '{"lockout":"active","reason":"failed_pin_threshold"}';

export type PinLockoutAuditInput = Readonly<{
  org_id: Uuid;
  store_id: Uuid;
  actor_staff_id: Uuid;
  target_staff_id: Uuid;
  device_id: Uuid;
  attempted_at: number;
}>;

export async function writePinLockoutAudit(
  client: PgPoolClient,
  input: PinLockoutAuditInput,
): Promise<void> {
  await writeAudit(client, {
    id: randomUUID(),
    orgId: input.org_id,
    storeId: input.store_id,
    staffId: input.actor_staff_id,
    via: "ui",
    command: "identity.pin.locked",
    idempotencyKey: null,
    dryRun: false,
    entity: "staff",
    entityId: input.target_staff_id,
    beforeJson: null,
    afterJson: LOCKOUT_AFTER_JSON,
    ip: null,
    deviceId: input.device_id,
    at: epochToDate(input.attempted_at),
  });
}
