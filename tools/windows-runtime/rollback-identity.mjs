import { fail } from "./companion-contract.mjs";
import { identifier } from "./portable-schema.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const STAFF = ["password_hash", "pin_hash", "is_active", "permission_version"];
const ROLE = ["role", "is_privacy_admin", "is_active"];

/** Current identity authority stays in process memory, never in export artifacts. */
export async function readRollbackIdentity(client) {
  const staffs = (
    await client.query(
      "SELECT org_id,id,password_hash,pin_hash,is_active,permission_version FROM public.staffs LIMIT 10001",
    )
  ).rows;
  const roles = (
    await client.query(
      "SELECT org_id,store_id,staff_id,role,is_privacy_admin,is_active FROM public.staff_store_roles LIMIT 10001",
    )
  ).rows;
  if (staffs.length > 10000 || roles.length > 10000) fail("RESTORE_IDENTITY_TOO_LARGE");
  for (const staff of staffs)
    if (
      ![staff.org_id, staff.id].every((id) => typeof id === "string" && UUID.test(id)) ||
      typeof staff.password_hash !== "string" ||
      staff.password_hash.length > 4096 ||
      !(
        staff.pin_hash === null ||
        (typeof staff.pin_hash === "string" && staff.pin_hash.length <= 4096)
      ) ||
      typeof staff.is_active !== "boolean" ||
      !Number.isInteger(staff.permission_version) ||
      staff.permission_version < 1
    )
      fail("RESTORE_IDENTITY_INVALID");
  for (const role of roles)
    if (
      ![role.org_id, role.store_id, role.staff_id].every(
        (id) => typeof id === "string" && UUID.test(id),
      ) ||
      !["admin", "staff"].includes(role.role) ||
      typeof role.is_privacy_admin !== "boolean" ||
      typeof role.is_active !== "boolean"
    )
      fail("RESTORE_IDENTITY_INVALID");
  return { staffs, roles };
}

export async function overlayRollbackIdentity(client, schema, snapshot) {
  for (const [name, columns, rows, keys] of [
    ["staffs", STAFF, snapshot.staffs, ["org_id", "id"]],
    ["staff_store_roles", ROLE, snapshot.roles, ["org_id", "store_id", "staff_id"]],
  ]) {
    const table = schema.find((item) => item.name === name);
    if (
      !table ||
      ![
        ...keys,
        "is_active",
        ...(name === "staffs" ? ["password_hash", "permission_version"] : ["role"]),
      ].every((key) => table.columns.some((column) => column.name === key))
    )
      fail("RESTORE_IDENTITY_SCHEMA_INVALID");
    const known = [...keys, ...columns]
      .map((key) => table.columns.find((column) => column.name === key))
      .filter(Boolean);
    const declaration = known
      .map((column) => `${identifier(column.name)} ${column.type}`)
      .join(",");
    const match = keys.map((key) => `s.${identifier(key)}=v.${identifier(key)}`).join(" AND ");
    const fields = columns.filter((key) => known.some((column) => column.name === key));
    const set = fields
      .map(
        (key) =>
          `${identifier(key)}=${key === "permission_version" ? "GREATEST(s.permission_version,v.permission_version)+1" : `v.${identifier(key)}`}`,
      )
      .join(",");
    const values = JSON.stringify(rows);
    const disable =
      name === "staff_store_roles" && fields.includes("is_privacy_admin")
        ? "is_active=false,is_privacy_admin=false"
        : "is_active=false";
    await client.query(
      `UPDATE public.${identifier(name)} s SET ${disable} WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS v(${declaration}) WHERE ${match})`,
      [values],
    );
    await client.query(
      `UPDATE public.${identifier(name)} s SET ${set} FROM jsonb_to_recordset($1::jsonb) AS v(${declaration}) WHERE ${match}`,
      [values],
    );
  }
}
