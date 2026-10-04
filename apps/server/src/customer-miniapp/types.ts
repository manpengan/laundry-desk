import type { CommandErrorCode } from "@laundry/contracts";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { PoolClient } from "pg";
import { LOCAL_PROFILE } from "../local/profile.js";

export class MiniappError extends Error {
  constructor(readonly code: CommandErrorCode) {
    super(code);
    this.name = "MiniappError";
  }
}
// Non-staff transaction scope. Actual delegated staff is injected only after a locked authority check.
export const MINIAPP_TENANT: TenantContext = Object.freeze({
  orgId: LOCAL_PROFILE.orgId,
  storeId: LOCAL_PROFILE.storeId,
  staffId: "00000000-0000-4000-8000-000000000000",
});
export type MiniappSettingsRow = Readonly<{
  version: number;
  enabled: boolean;
  transactions_enabled: boolean;
  delegated_staff_id: string | null;
  app_id: string;
  credential_id: string;
  envelope_json: unknown;
  subscription_template_ids: readonly string[];
}>;
export type MiniappIdentity = Readonly<{
  sessionId: string;
  bindingId: string;
  customerId: string;
  configVersion: number;
  openId: string;
  expiresAt: number;
}>;
export type MiniappTransaction = Readonly<{
  client: SqlClient;
  raw: PoolClient;
  identity: MiniappIdentity;
  settings: MiniappSettingsRow;
  tenant: TenantContext;
  customerId: string;
}>;
export async function readMiniappSettings(client: SqlClient, lock = false) {
  return (
    (
      await client.query<MiniappSettingsRow>(
        `SELECT version,enabled,transactions_enabled,
    delegated_staff_id::text,app_id,credential_id::text,envelope_json,subscription_template_ids
    FROM miniapp_settings WHERE org_id=$1::uuid AND store_id=$2::uuid${lock ? " FOR SHARE" : ""}`,
        [MINIAPP_TENANT.orgId, MINIAPP_TENANT.storeId],
      )
    ).rows[0] ?? null
  );
}
