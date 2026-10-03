import { createHash } from "node:crypto";
import type { SqlClient } from "../db/types.js";
import { STORE_EXPORT_SCHEMA } from "./store-export-schema.js";

const exclusions = Object.freeze({
  ai_circuit_breakers: "运行时熔断状态",
  ai_cost_reservations: "执行中的额度预留；实际用量保存在 ai_usage",
  ai_pending_actions: "待执行命令及授权",
  ai_approval_requests: "执行审批及权限版本",
  ai_provider_keys: "加密供应商凭据",
  command_idempotency: "命令重放与幂等执行状态",
  customer_erasure_tombstones: "隐私擦除防复活 HMAC",
  customer_phone_history: "隐私历史 HMAC",
  customer_privacy_hmac_keys: "隐私 HMAC 密钥",
  customer_portal_sessions: "顾客会话及 CSRF 凭据",
  edge_authority_challenges: "设备配对挑战及授权",
  edge_devices: "设备认证权限",
  local_bootstrap_metadata: "实例引导与准入权限",
  offline_grant_replay_state: "离线授权重放状态",
  offline_grants: "离线签名授权",
  pin_challenges: "PIN 验证挑战",
  pin_lockouts: "PIN 认证锁定状态",
  primary_lease_heads: "主设备租约",
  primary_lease_replay_state: "主设备重放权限状态",
  primary_leases: "签名租约",
  print_device_receipt_heads: "打印设备回执重放状态",
  refresh_families: "登录刷新权限",
  refresh_tokens: "登录刷新令牌",
  sessions: "员工登录会话",
  staff_credential_setups: "凭据设置权限",
  staff_store_roles: "执行权限角色",
  step_up_proofs: "提权证明",
  ticket_counters: "单号分配执行状态",
  v1_import_requests: "一次性迁移权限",
  store_export_requests: "一次性导出权限",
  laundry_schema_migrations: "安装版本内部校验账本",
});
const omittedColumns: Readonly<Record<string, readonly string[]>> = Object.freeze({
  staffs: ["password_hash", "pin_hash", "permission_version"],
  automation_policies: ["active_run_id", "lease_token", "lease_until"],
  notification_provider_settings: ["credential_id", "envelope_json"],
  notification_deliveries: ["recipient_hmac", "lease_token", "lease_until", "worker_id"],
  print_jobs: [
    "payload_bytes",
    "artifact_path",
    "ticket_nonce",
    "capability_json",
    "lease_until",
    "worker_id",
  ],
});
export type ExportColumn = Readonly<{ name: string; type: string }>;
export type ExportTable = Readonly<{
  name: string;
  scope: "store" | "org" | "registry";
  columns: readonly ExportColumn[];
  omitted_columns: readonly string[];
}>;
export const EXPORT_POLICY_VERSION = 1;
export const EXPORT_EXCLUSIONS: Readonly<Record<string, string>> = exclusions;
export function exportIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new Error("STORE_EXPORT_SCHEMA_INVALID");
  return `"${value}"`;
}
const parsed = STORE_EXPORT_SCHEMA.map((line) => {
  const [name, ...columns] = line.split("|");
  return {
    name: name!,
    columns: columns.map((column) => {
      const colon = column.indexOf(":");
      return { name: column.slice(0, colon), type: column.slice(colon + 1) };
    }),
  };
});
export const EXPORT_TABLES: readonly ExportTable[] = Object.freeze(
  parsed
    .filter((table) => !(table.name in exclusions))
    .map((table) => ({
      name: table.name,
      scope:
        table.columns.some((column) => column.name === "store_id") || table.name === "stores"
          ? ("store" as const)
          : table.name === "ai_model_registry"
            ? ("registry" as const)
            : ("org" as const),
      columns: table.columns.filter(
        (column) =>
          !(omittedColumns[table.name] ?? []).includes(column.name) &&
          column.name !== "auth_session_id",
      ),
      omitted_columns: table.columns
        .filter(
          (column) =>
            (omittedColumns[table.name] ?? []).includes(column.name) ||
            column.name === "auth_session_id",
        )
        .map((column) => column.name),
    })),
);
export const exportPolicyHash = () =>
  createHash("sha256")
    .update(JSON.stringify({ version: EXPORT_POLICY_VERSION, tables: EXPORT_TABLES, exclusions }))
    .digest("hex");

export async function verifyExportSchema(client: SqlClient): Promise<void> {
  const result = await client.query<{
    name: string;
    columns: ExportColumn[];
  }>(`SELECT c.relname AS name,
    json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod)) ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p') GROUP BY c.relname ORDER BY c.relname`);
  const business = result.rows.filter(
    (row) => !["laundry_schema_migrations", "store_export_requests"].includes(row.name),
  );
  if (JSON.stringify(business) !== JSON.stringify(parsed))
    throw new Error("STORE_EXPORT_SCHEMA_UNREVIEWED");
}
