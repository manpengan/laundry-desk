import type { SqlClient } from "../db/types.js";
import { PrintDispatchError, type PrintDispatchSession } from "./dispatch-service.js";

export type PrintDeviceRow = Readonly<{
  public_key_spki: string;
  status: "paired" | "revoked";
}>;
type ClockRow = Readonly<{ now: Date }>;

export function printDispatchTenant(session: PrintDispatchSession) {
  return Object.freeze({
    orgId: session.orgId,
    storeId: session.storeId,
    staffId: session.staffId,
  });
}

/** Lock every known device; each operation applies its own paired-status policy afterward. */
export async function lockPrintDevice(
  client: SqlClient,
  session: PrintDispatchSession,
): Promise<PrintDeviceRow> {
  const result = await client.query<PrintDeviceRow>(
    `SELECT public_key_spki, status
       FROM edge_devices
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND device_id = $3::uuid
      FOR UPDATE`,
    [session.orgId, session.storeId, session.deviceId],
  );
  const row = result.rows[0];
  if (row === undefined || result.rows.length !== 1) {
    throw new PrintDispatchError("device_unavailable");
  }
  return row;
}

export function requirePairedPrintDevice(device: PrintDeviceRow): void {
  if (device.status !== "paired") throw new PrintDispatchError("device_unavailable");
}

export async function printDatabaseNow(client: SqlClient): Promise<Date> {
  const result = await client.query<ClockRow>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("PostgreSQL did not return a valid dispatch clock");
  }
  return now;
}
