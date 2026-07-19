import { getDb, schema, type DbExecutor } from "../db";

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "pickup"
  | "cancel"
  | "login"
  | "export";

export interface AuditLogInput {
  staffId?: number;
  action: AuditAction;
  entity: string;
  entityId?: number;
  diff?: unknown;
}

export class AuditService {
  static log(params: AuditLogInput, db: DbExecutor = getDb()): void {
    db.insert(schema.auditLog)
      .values({
        staffId: params.staffId,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        diff: params.diff === undefined ? null : JSON.stringify(params.diff),
      })
      .run();
  }
}
