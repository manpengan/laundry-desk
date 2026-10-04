import { createHash, randomUUID } from "node:crypto";
import type { RemoteAssistanceCommand } from "@laundry/contracts";
import type { AuthorizedSession } from "../auth/session-view.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { PgPool } from "../db/pg-pool.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { writeAudit } from "../audit/write-audit.js";
import { parseRuntimeRelease } from "../runtime/runtime-release.js";

export type AssistanceGrant = Readonly<{
  id: string;
  auth: AuthorizedSession;
  approvedAt: number;
  expiresAt: number;
}>;
export type StoredAssistance = Readonly<{
  id: string;
  status: "active" | "revoked" | "expired" | "interrupted";
  expires_at: Date;
  commands_completed: number;
}>;
export const assistanceTenant = (auth: AuthorizedSession): TenantContext => ({
  orgId: auth.session.org_id,
  storeId: auth.session.store_id,
  staffId: auth.session.staff_id,
});
async function audit(
  client: SqlClient,
  tenant: TenantContext,
  id: string,
  action: string,
  details: unknown,
) {
  await writeAudit(client, {
    id: randomUUID(),
    ...tenant,
    staffId: tenant.staffId ?? null,
    via: "ui",
    command: `remote_assistance.${action}`,
    idempotencyKey: null,
    dryRun: false,
    entity: "remote_assistance_sessions",
    entityId: id,
    beforeJson: null,
    afterJson: JSON.stringify(details),
    ip: null,
    deviceId: null,
    at: new Date(),
  });
}
async function currentActor(client: SqlClient, auth: AuthorizedSession) {
  const s = auth.session;
  const result = await client.query(
    `SELECT s.id FROM sessions s JOIN staffs a ON a.org_id=s.org_id AND a.id=s.staff_id
    JOIN staff_store_roles r ON r.org_id=s.org_id AND r.store_id=s.store_id AND r.staff_id=s.staff_id
    JOIN refresh_families f ON f.org_id=s.org_id AND f.store_id=s.store_id AND f.session_id=s.id
    WHERE s.id=$1 AND s.staff_id=$2 AND s.session_version=$3 AND s.permission_version=$4 AND a.permission_version=$4
    AND s.status='active' AND a.is_active AND r.is_active AND r.role='admin' AND f.id=$5 AND f.status='active'
    FOR SHARE OF s,a,r,f`,
    [s.session_id, s.staff_id, s.session_version, s.permission_version, s.family_id],
  );
  if (result.rows.length !== 1) throw new Error("ASSISTANCE_AUTHORITY_INVALID");
}
export function createAssistanceRepository(
  pool: PgPool,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const transaction = <T>(
    auth: AuthorizedSession,
    action: (client: SqlClient, tenant: TenantContext) => Promise<T>,
  ) =>
    withPoolClient(pool, (client) =>
      withTenantTransaction(client, assistanceTenant(auth), () =>
        action(client, assistanceTenant(auth)),
      ),
    );
  const check = async (client: SqlClient, grant: AssistanceGrant) => {
    await currentActor(client, grant.auth);
    const row = await client.query(
      `SELECT id FROM remote_assistance_sessions WHERE id=$1 AND status='active' AND revoked_at IS NULL AND expires_at>statement_timestamp()
      AND actor_id=$2 AND session_id=$3 AND session_version=$4 AND permission_version=$5 AND approved_at=$6 AND expires_at=$7 FOR UPDATE`,
      [
        grant.id,
        grant.auth.session.staff_id,
        grant.auth.session.session_id,
        grant.auth.session.session_version,
        grant.auth.session.permission_version,
        new Date(grant.approvedAt),
        new Date(grant.expiresAt),
      ],
    );
    if (row.rows.length !== 1) throw new Error("ASSISTANCE_AUTHORITY_INVALID");
  };
  return Object.freeze({
    async approve(grant: AssistanceGrant) {
      return transaction(grant.auth, async (client, tenant) => {
        await currentActor(client, grant.auth);
        const previous = await client.query<{ id: string }>(
          "UPDATE remote_assistance_sessions SET status='interrupted',revoked_at=statement_timestamp() WHERE status='active' RETURNING id",
        );
        for (const row of previous.rows) await audit(client, tenant, row.id, "interrupted", {});
        const s = grant.auth.session;
        await client.query(
          `INSERT INTO remote_assistance_sessions(id,org_id,store_id,actor_id,session_id,session_version,permission_version,approved_at,expires_at,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'active')`,
          [
            grant.id,
            tenant.orgId,
            tenant.storeId,
            tenant.staffId,
            s.session_id,
            s.session_version,
            s.permission_version,
            new Date(grant.approvedAt),
            new Date(grant.expiresAt),
          ],
        );
        await audit(client, tenant, grant.id, "authorize", {
          expires_at: grant.expiresAt,
          consent: true,
          scope: "diagnostics_only",
        });
      });
    },
    async status(
      auth: AuthorizedSession,
      activeId: string | null,
    ): Promise<StoredAssistance | null> {
      return transaction(auth, async (client, tenant) => {
        const ended = await client.query<{ id: string; status: string }>(
          `UPDATE remote_assistance_sessions SET status=CASE WHEN expires_at<=statement_timestamp() THEN 'expired' ELSE 'interrupted' END,
          revoked_at=statement_timestamp() WHERE status='active' AND (id IS DISTINCT FROM $1::uuid OR expires_at<=statement_timestamp()) RETURNING id,status`,
          [activeId],
        );
        for (const row of ended.rows) await audit(client, tenant, row.id, row.status, {});
        const result = await client.query<StoredAssistance>(
          `SELECT s.id,s.status,s.expires_at,(SELECT count(*)::integer FROM remote_assistance_commands c WHERE c.assistance_id=s.id) AS commands_completed
          FROM remote_assistance_sessions s ORDER BY (s.id=$1::uuid) DESC NULLS LAST,s.approved_at DESC,s.id DESC LIMIT 1`,
          [activeId],
        );
        return result.rows[0] ?? null;
      });
    },
    async terminate(grant: AssistanceGrant, status: "revoked" | "expired" | "interrupted") {
      return transaction(grant.auth, async (client, tenant) => {
        const result = await client.query(
          "UPDATE remote_assistance_sessions SET status=$2,revoked_at=statement_timestamp() WHERE id=$1 AND status='active' RETURNING id",
          [grant.id, status],
        );
        if (result.rowCount) await audit(client, tenant, grant.id, status, {});
      });
    },
    async revoke(auth: AuthorizedSession, id: string) {
      return transaction(auth, async (client, tenant) => {
        await currentActor(client, auth);
        const selected = await client.query(
          "SELECT id FROM remote_assistance_sessions WHERE id=$1 FOR UPDATE",
          [id],
        );
        if (selected.rows.length !== 1) throw new Error("ASSISTANCE_SESSION_UNKNOWN");
        const result = await client.query(
          "UPDATE remote_assistance_sessions SET status='revoked',revoked_at=statement_timestamp() WHERE id=$1 AND status='active' RETURNING id",
          [id],
        );
        await audit(client, tenant, id, "revoke", { changed: result.rowCount === 1 });
      });
    },
    async verify(grant: AssistanceGrant) {
      return transaction(grant.auth, (client) => check(client, grant));
    },
    async execute(
      grant: AssistanceGrant,
      requestId: string,
      command: RemoteAssistanceCommand,
      operatorHash: string,
    ) {
      return transaction(grant.auth, async (client, tenant) => {
        await check(client, grant);
        let result: unknown;
        if (command === "runtime.health") {
          await client.query("SELECT 1");
          result = { database: "ready", mode: "windows_local" };
        } else if (command === "runtime.version") {
          const version = parseRuntimeRelease(environment);
          result = { protocol: 1, release: version.release, schema_head: version.migrationHead };
        } else if (command === "maintenance.summary") {
          const rows = await client.query<{ completed_events: number }>(
            "SELECT count(*)::integer AS completed_events FROM audit_log WHERE command='runtime.restore.revoke_authority' AND at>=statement_timestamp()-interval '30 days'",
          );
          result = { window_days: 30, restore_events: rows.rows[0]?.completed_events ?? 0 };
        } else throw new Error("ASSISTANCE_COMMAND_DENIED");
        const hash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
        await client.query(
          "INSERT INTO remote_assistance_commands(id,org_id,store_id,assistance_id,command,operator_sha256,result_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [requestId, tenant.orgId, tenant.storeId, grant.id, command, operatorHash, hash],
        );
        await audit(client, tenant, grant.id, "command", {
          request_id: requestId,
          command,
          operator_sha256: operatorHash,
          result_sha256: hash,
        });
        return result;
      });
    },
    async delivered(grant: AssistanceGrant, requestId: string) {
      return transaction(grant.auth, async (client, tenant) => {
        const result = await client.query(
          "UPDATE remote_assistance_commands SET delivered_at=statement_timestamp() WHERE id=$1 AND assistance_id=$2 AND delivered_at IS NULL RETURNING id",
          [requestId, grant.id],
        );
        if (result.rowCount)
          await audit(client, tenant, grant.id, "delivered", { request_id: requestId });
      });
    },
  });
}
export type AssistanceRepository = ReturnType<typeof createAssistanceRepository>;
