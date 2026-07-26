import { randomUUID } from "node:crypto";

import { writeAudit } from "../audit/write-audit.js";
import type { PgPoolClient } from "../db/pg-pool.js";
import { epochToDate } from "./pg-store-mappers.js";
import type { Uuid } from "./types.js";

export type LifecycleAuditInput = Readonly<{
  command: "identity.logout" | "identity.refresh.reuse_revoked";
  org_id: Uuid;
  store_id: Uuid;
  staff_id: Uuid;
  session_id: Uuid;
  device_id: Uuid;
  at: number;
}>;

export async function writeLifecycleAudit(
  client: PgPoolClient,
  input: LifecycleAuditInput,
): Promise<void> {
  await writeAudit(client, {
    id: randomUUID(),
    orgId: input.org_id,
    storeId: input.store_id,
    staffId: input.staff_id,
    via: "ui",
    command: input.command,
    idempotencyKey: null,
    dryRun: false,
    entity: "session",
    entityId: input.session_id,
    beforeJson: null,
    afterJson: '{"family_status":"revoked","session_status":"revoked"}',
    ip: null,
    deviceId: input.device_id,
    at: epochToDate(input.at),
  });
}
