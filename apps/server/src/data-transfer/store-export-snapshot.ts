import { join } from "node:path";
import { z } from "zod";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { PhotoFileStore, StoredPhoto } from "../photo/file-store.js";
import {
  EXPORT_EXCLUSIONS,
  EXPORT_POLICY_VERSION,
  EXPORT_TABLES,
  exportIdentifier,
  exportPolicyHash,
  type ExportTable,
} from "./store-export-policy.js";
import {
  createExportWriter,
  exportPrivateFile,
  STORE_EXPORT_MAX_BYTES,
  type ExportFile,
} from "./store-export-files.js";
import type { StoreExportManifest } from "./store-export-verify.js";

type PhotoReader = Pick<PhotoFileStore, "read">;
export type ExportPhotoReaders = Readonly<{ garment: PhotoReader; delivery: PhotoReader }>;
type TextRow = Record<string, string | null>;
const photoMetadata = z.object({
  storage_key: z.string(),
  content_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  byte_size: z.coerce
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
});
const keyPattern =
  /^(?:delivery-)?[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:jpg|png|webp)$/u;
const secretKey = (key: string) =>
  /(?:password|passwordhash|pinhash|secret|privatekey|apikey|accesskeyid|accesskeysecret|refreshtoken|accesstoken|csrftoken|wrappeddek|ciphertext)$/iu.test(
    key.replace(/[^a-z0-9]/giu, ""),
  );
/** Opaque settings may not become a backdoor for credential export. Fail, never silently truncate. */
function guardOpaqueFields(table: ExportTable, row: TextRow) {
  const walk = (value: unknown, depth: number): void => {
    if (depth > 32) throw new Error("STORE_EXPORT_SETTINGS_UNREVIEWED");
    if (Array.isArray(value)) {
      for (const child of value) walk(child, depth + 1);
      return;
    }
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        if (secretKey(key)) throw new Error("STORE_EXPORT_SETTINGS_UNREVIEWED");
        walk(child, depth + 1);
      }
  };
  if (table.name === "settings" && secretKey(row.key ?? ""))
    throw new Error("STORE_EXPORT_SETTINGS_UNREVIEWED");
  for (const column of table.columns) {
    const value = row[column.name];
    if (typeof value !== "string") continue;
    if (column.type === "jsonb" || column.type === "json" || column.name.endsWith("_json")) {
      walk(JSON.parse(value) as unknown, 0);
    }
  }
}
function filter(table: ExportTable, tenant: TenantContext) {
  if (table.name === "ai_model_registry") return { clause: "TRUE", values: [] };
  if (table.name === "orgs") return { clause: "id=$1", values: [tenant.orgId] };
  if (table.name === "stores")
    return { clause: "org_id=$1 AND id=$2", values: [tenant.orgId, tenant.storeId] };
  return table.scope === "store"
    ? { clause: "org_id=$1 AND store_id=$2", values: [tenant.orgId, tenant.storeId] }
    : { clause: "org_id=$1", values: [tenant.orgId] };
}
async function exportTable(
  client: SqlClient,
  table: ExportTable,
  tenant: TenantContext,
  root: string,
  onRow: (row: TextRow) => Promise<void>,
) {
  const scope = filter(table, tenant);
  const columns = table.columns.map((column) => `${exportIdentifier(column.name)}::text`).join(",");
  const writer = await createExportWriter(join(root, "tables", `${table.name}.jsonl`));
  let rows = 0;
  try {
    await client.query(
      `DECLARE store_export_cursor NO SCROLL CURSOR FOR
      SELECT json_build_array(${columns}) AS values FROM ${exportIdentifier(table.name)} WHERE ${scope.clause}`,
      scope.values,
    );
    while (true) {
      const batch = await client.query<{ values: Array<string | null> }>(
        "FETCH 64 FROM store_export_cursor",
      );
      if (!batch.rows.length) break;
      for (const result of batch.rows) {
        if (
          result.values.length !== table.columns.length ||
          result.values.some((value) => value !== null && typeof value !== "string")
        )
          throw new Error("STORE_EXPORT_ROW_INVALID");
        const row = Object.fromEntries(
          table.columns.map((column, i) => [column.name, result.values[i]!]),
        ) as TextRow;
        guardOpaqueFields(table, row);
        const line = `${JSON.stringify(row)}\n`;
        if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("STORE_EXPORT_ROW_LIMIT");
        await writer.append(line);
        await onRow(row);
        rows += 1;
        if (rows > 5_000_000) throw new Error("STORE_EXPORT_ROW_LIMIT");
      }
    }
    await client.query("CLOSE store_export_cursor");
    return { file: { ...(await writer.finish()), path: `tables/${table.name}.jsonl` }, rows };
  } catch (error) {
    await writer.close();
    throw error;
  }
}
export async function writeStoreSnapshot(
  client: SqlClient,
  tenant: TenantContext,
  requestId: string,
  root: string,
  readers: ExportPhotoReaders,
): Promise<StoreExportManifest> {
  await client.query("SET LOCAL timezone='UTC'");
  await client.query("SET LOCAL datestyle='ISO, YMD'");
  await client.query("SET LOCAL bytea_output='hex'");
  const files: ExportFile[] = [];
  const tables: StoreExportManifest["tables"] = [];
  const photos: StoreExportManifest["photos"] = [];
  const copied = new Map<string, StoredPhoto>();
  let totalBytes = 0;
  const addFile = (file: ExportFile) => {
    totalBytes += file.bytes;
    if (totalBytes > STORE_EXPORT_MAX_BYTES) throw new Error("STORE_EXPORT_SIZE_LIMIT");
    files.push(file);
  };
  for (const table of EXPORT_TABLES) {
    const exported = await exportTable(client, table, tenant, root, async (row) => {
      if (table.name !== "garment_photos" && table.name !== "delivery_evidence_attachments") return;
      const metadata = photoMetadata.parse(row);
      if (!keyPattern.test(metadata.storage_key) || photos.length >= 20_000)
        throw new Error("STORE_EXPORT_PHOTO_INVALID");
      const path = `photos/${metadata.storage_key}`;
      const prior = copied.get(path);
      if (prior && JSON.stringify(prior) !== JSON.stringify(metadata))
        throw new Error("STORE_EXPORT_PHOTO_INVALID");
      if (!prior) {
        const reader = table.name === "garment_photos" ? readers.garment : readers.delivery;
        const photo = await reader.read(metadata);
        addFile({ ...(await exportPrivateFile(join(root, path), photo.bytes)), path });
        copied.set(path, metadata);
      }
      photos.push({
        table: table.name,
        id: z.uuid().parse(row.id),
        storage_key: metadata.storage_key,
        path,
      });
    });
    addFile(exported.file);
    tables.push({ name: table.name, rows: exported.rows, path: exported.file.path });
  }
  addFile(
    await exportPrivateFile(
      join(root, "data-dictionary.json"),
      JSON.stringify(
        {
          format_version: 1,
          policy_version: EXPORT_POLICY_VERSION,
          policy_sha256: exportPolicyHash(),
          representation:
            "UTF-8 JSON Lines; each non-null PostgreSQL value is its exact text representation; null remains JSON null",
          money: "*_cents are integer cents; never binary floating point",
          timestamps: "UTC ISO PostgreSQL text",
          scope:
            "store tables: current store; org tables: shared organization resources; registry: nonsecret global model catalog",
          tables: EXPORT_TABLES,
          excluded_tables: EXPORT_EXCLUSIONS,
          omitted_columns_reason:
            "Credentials, active execution leases and authentication-session references are excluded; this archive cannot grant authority or restore an instance.",
        },
        null,
        2,
      ),
    ),
  );
  addFile(
    await exportPrivateFile(
      join(root, "README.md"),
      `# 整店业务数据与照片导出\n\n版本 1。含个人资料，请由店主妥善保存。\n\n- tables/*.jsonl：一行一个业务记录，字段名与数据库一致。非空值均为字符串，保留大整数、金额与时间精度；空值为 null。\n- data-dictionary.json：完整导出表、字段、PostgreSQL 类型、范围、排除表与凭据字段说明。没有悄悄省略的新表或新字段。\n- photos/：当前店铺数据库引用的衣物照片与配送凭证；manifest.photos 可关联源记录。\n- manifest.json：逐表行数、逐文件字节数及 SHA-256。生成时已全部重读验证。SHA-256 用于完整性检查，不是数字签名。\n\n店级业务只含当前店；顾客、会员、组织配置等共享资源按组织导出。员工账号不含密码、PIN 或执行权限。会话、密钥、离线授权、审批执行状态不导出。\n\n本包用于查阅与数据交接；换机恢复请使用加密换机包。当前发行验收等级：development_only。\n\n可在项目源码目录执行 node tools/data-transfer/verify-store-export.mjs <本 data 目录> <导出成功时的 manifest_sha256> 验证文件是否完整。\n`,
    ),
  );
  return {
    format: "laundry-store-export",
    version: 1,
    policy_sha256: exportPolicyHash(),
    request_id: requestId,
    org_id: tenant.orgId,
    store_id: tenant.storeId!,
    actor_id: tenant.staffId!,
    created_at: new Date().toISOString(),
    assurance: "development_only",
    scope: "current_store_and_shared_org_resources",
    tables,
    photos,
    files,
  };
}
