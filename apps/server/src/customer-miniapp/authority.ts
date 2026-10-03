import { randomUUID } from "node:crypto";
import { parseContractInput } from "@laundry/contracts";
import { permissionsForAuthority, createRuntimeBus } from "../bus/runtime.js";
import { actorHasInvariantPermissions } from "../bus/rbac.js";
import { evaluateCurrentCommandPolicy } from "../handlers/default-chain-hooks.js";
import { writeAuditForOutcome } from "../bus/audit-outcome.js";
import type { ActorContext, BusContext } from "../bus/types.js";
import type { LocalRuntime } from "../local/runtime-types.js";
import type { MiniappTransaction } from "./types.js";
import { MiniappError } from "./types.js";

export async function delegation(tx: MiniappTransaction) {
  if (!tx.settings.transactions_enabled || tx.settings.delegated_staff_id === null)
    throw new MiniappError("POLICY_DENIED");
  const staff = (
    await tx.client.query<{
      id: string;
      permission_version: number;
      role: "admin" | "staff";
      is_privacy_admin: boolean;
    }>(
      `SELECT s.id::text,s.permission_version,r.role,r.is_privacy_admin
    FROM staffs s JOIN staff_store_roles r ON r.org_id=s.org_id AND r.staff_id=s.id WHERE s.org_id=$1::uuid AND s.id=$2::uuid
    AND s.is_active AND r.store_id=$3::uuid AND r.is_active FOR SHARE OF s,r`,
      [tx.tenant.orgId, tx.settings.delegated_staff_id, tx.tenant.storeId],
    )
  ).rows[0];
  if (staff === undefined) throw new MiniappError("PERMISSION_DENIED");
  const actor: ActorContext = Object.freeze({
    staffId: staff.id,
    deviceId: null,
    via: "ui",
    permissions: permissionsForAuthority(staff),
  });
  await tx.client.query("SELECT set_config('app.staff_id',$1,true)", [staff.id]);
  return Object.freeze({
    actor,
    permissionVersion: staff.permission_version,
    tenant: { ...tx.tenant, staffId: staff.id },
  });
}
export type Delegation = Awaited<ReturnType<typeof delegation>>;
export async function requireOwnedOrder(tx: MiniappTransaction, id: string) {
  const row = (
    await tx.client.query<{ customer_id: string; balance_cents: number }>(
      `SELECT customer_id::text,balance_cents FROM orders
    WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid AND customer_canonical_root(customer_id)=$4::uuid FOR UPDATE`,
      [tx.tenant.orgId, tx.tenant.storeId, id, tx.customerId],
    )
  ).rows[0];
  if (row === undefined) throw new MiniappError("RESOURCE_UNAVAILABLE");
  return row;
}
export async function ownedAccount(tx: MiniappTransaction) {
  const rows = await tx.client.query<{ id: string; customer_id: string }>(
    `SELECT id::text,customer_id::text FROM member_accounts WHERE org_id=$1::uuid
    AND customer_canonical_root(customer_id)=$2::uuid AND status='active' ORDER BY id FOR UPDATE`,
    [tx.tenant.orgId, tx.customerId],
  );
  if (rows.rows.length !== 1 || rows.rows[0] === undefined)
    throw new MiniappError("RESOURCE_UNAVAILABLE");
  return rows.rows[0];
}
export function createMiniappDomainExecutor(local: LocalRuntime) {
  const registry = createRuntimeBus(local).registry;
  return async (
    tx: MiniappTransaction,
    authority: Delegation,
    name: string,
    input: unknown,
    key: string,
  ) => {
    if (
      ![
        "delivery.appointment.create",
        "delivery.appointment.cancel",
        "member.balance.pay",
        "member.asset.consume",
        "member.points.redeem",
      ].includes(name)
    )
      throw new MiniappError("POLICY_DENIED");
    const command = registry.get(name);
    if (command?.handler === undefined) throw new MiniappError("RESOURCE_UNAVAILABLE");
    const parsed = await parseContractInput(command.definition, input);
    const context: BusContext = {
      tenant: authority.tenant,
      actor: authority.actor,
      definition: command.definition,
      transactionClient: tx.client,
      request: {
        name,
        version: command.definition.version,
        input: parsed,
        dryRun: false,
        idempotencyKey: key,
      },
    };
    if (!actorHasInvariantPermissions(authority.actor, command.definition.invariants))
      throw new MiniappError("PERMISSION_DENIED");
    const policy = evaluateCurrentCommandPolicy(context, parsed);
    // ADR-86 grants customer-confirmed fixed R2/R3 actions only. R4/R5 remain unavailable.
    if (
      policy === null ||
      policy.outcome === "deny" ||
      policy.effectiveRisk === "R4" ||
      policy.effectiveRisk === "R5"
    )
      throw new MiniappError("POLICY_DENIED");
    const outcome = await command.handler({ ...context, client: tx.client, parsed });
    await writeAuditForOutcome(tx.client, context, outcome.audit, {});
    return outcome.result;
  };
}
export async function miniappAudit(
  tx: MiniappTransaction,
  authority: Delegation,
  action: string,
  receiptId: string,
) {
  await tx.client.query(
    `INSERT INTO audit_log(id,org_id,store_id,staff_id,via,command,dry_run,entity,entity_id,after_json,at)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'ui',$5,false,'miniapp_transaction_receipts',$6,$7,statement_timestamp())`,
    [
      randomUUID(),
      tx.tenant.orgId,
      tx.tenant.storeId,
      authority.actor.staffId,
      `miniapp.${action}`,
      receiptId,
      JSON.stringify({
        customer_id: tx.customerId,
        customer_session_id: tx.identity.sessionId,
        delegated_staff_id: authority.actor.staffId,
        config_version: tx.settings.version,
      }),
    ],
  );
}
