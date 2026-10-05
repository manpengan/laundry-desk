import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  ReceiveRecoveryDraftSchema,
  ReceiveRecoverySnapshotSchema,
  CommandResponseSchema,
  type DesktopSessionView,
  type ReceiveRecoveryDraft,
  type ReceiveRecoverySnapshot,
} from "@laundry/contracts";
import { OfflineReadCacheFile } from "../offline/read-cache-file.js";
import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import type { JsonHttpResponse } from "./http-transport-support.js";

const ScopeSchema = z.strictObject({
  org_id: z.string().min(1),
  store_id: z.string().min(1),
  staff_id: z.string().min(1),
  device_id: z.string().min(1),
});
type Scope = z.infer<typeof ScopeSchema>;
const OperationSchema = z.strictObject({
  version: z.literal(1),
  scope: ScopeSchema,
  operation_id: z.uuid(),
  key: z.uuid(),
  body: z.string().max(256 * 1024),
  attempts: z.number().int().positive().safe(),
  response: z
    .strictObject({
      statusCode: z.number().int().min(100).max(599),
      payload: CommandResponseSchema,
    })
    .nullable(),
});
const WorkspaceSchema = z.strictObject({
  version: z.literal(1),
  scope: ScopeSchema,
  draft: ReceiveRecoveryDraftSchema,
  prepared: z.boolean(),
});
type Operation = z.infer<typeof OperationSchema>;
export type RecoveryFile = Readonly<{
  read: () => unknown | null;
  write: (value: unknown) => void;
}>;
type FileFactory = (path: string) => RecoveryFile;

export class ReceiveRecoveryConflict extends Error {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** No TTL: an uncertain operation must never acquire a fresh key after a restart. */
export class ReceiveRecoveryJournal {
  private readonly file: FileFactory;
  constructor(
    private readonly root: string,
    safeStorage: SafeStorageSurface,
    factory?: FileFactory,
    private readonly newKey: () => string = randomUUID,
  ) {
    this.file = factory ?? ((path) => new OfflineReadCacheFile(path, safeStorage));
  }

  private scope(session: DesktopSessionView): Scope {
    const { org_id, store_id, staff_id, device_id } = session.session;
    return ScopeSchema.parse({ org_id, store_id, staff_id, device_id });
  }
  private path(scope: Scope, part: string): string {
    return join(this.root, hash(JSON.stringify(scope)), part);
  }
  private workspace(scope: Scope) {
    const raw = this.file(this.path(scope, "workspace")).read();
    if (raw === null) return null;
    const row = WorkspaceSchema.parse(raw);
    if (!same(scope, row.scope)) throw new Error("Recovery scope mismatch");
    return row;
  }
  private operation(scope: Scope, id: string): Operation | null {
    z.uuid().parse(id);
    const raw = this.file(this.path(scope, `operations/${id}`)).read();
    if (raw === null) return null;
    const row = OperationSchema.parse(raw);
    if (!same(scope, row.scope) || row.operation_id !== id)
      throw new Error("Recovery scope mismatch");
    return row;
  }

  load(session: DesktopSessionView): ReceiveRecoverySnapshot {
    const scope = this.scope(session);
    const workspace = this.workspace(scope);
    const draft = workspace?.draft ?? null;
    const operation = draft === null ? null : this.operation(scope, draft.operationId);
    if (workspace?.prepared === true && operation === null)
      throw new Error("Missing recovery operation");
    return ReceiveRecoverySnapshotSchema.parse({
      draft,
      pending_body: operation === null ? null : (JSON.parse(operation.body) as unknown),
      receipt: operation?.response?.payload ?? null,
    });
  }

  save(session: DesktopSessionView, value: ReceiveRecoveryDraft): void {
    const scope = this.scope(session);
    const draft = ReceiveRecoveryDraftSchema.parse(value);
    const current = this.load(session).draft;
    if (current !== null && current.operationId !== draft.operationId) {
      const old = this.operation(scope, current.operationId);
      if (old !== null && old.response === null)
        throw new ReceiveRecoveryConflict("先确认上一笔开单结果，再开始新单");
    }
    const operation = this.operation(scope, draft.operationId);
    const comparable = (value: ReceiveRecoveryDraft) => ({
      ...value,
      dirty: false,
      ...(operation?.response?.payload.ok === true ? { draftId: null } : {}),
    });
    if (
      current !== null &&
      current.operationId === draft.operationId &&
      operation !== null &&
      !same(comparable(current), comparable(draft))
    ) {
      throw new ReceiveRecoveryConflict("已提交的开单内容不能更换，请先确认原结果");
    }
    this.file(this.path(scope, "workspace")).write({
      version: 1,
      scope,
      draft,
      prepared: operation !== null,
    });
  }

  /** Both original wire body and actual key are durable before the first HTTP request. */
  prepare(session: DesktopSessionView, id: string, body: string): Operation {
    this.load(session); // Reject a missing/damaged prepared record even on the generic command path.
    const scope = this.scope(session);
    const previous = this.operation(scope, id);
    if (previous !== null) {
      if (previous.body !== body) throw new ReceiveRecoveryConflict("同一开单身份不能更换内容");
      const next = OperationSchema.parse({
        ...previous,
        attempts: previous.attempts + 1,
        // A refreshed-session retry is a new in-flight attempt. An earlier 401 cannot
        // prove this attempt failed if the server commits and its response is lost.
        response: previous.response?.payload.ok === true ? previous.response : null,
      });
      this.file(this.path(scope, `operations/${id}`)).write(next);
      return next;
    }
    const draft = this.workspace(scope)?.draft;
    if (draft?.operationId !== id) throw new ReceiveRecoveryConflict("请先保存当前开单内容");
    const row = OperationSchema.parse({
      version: 1,
      scope,
      operation_id: id,
      key: this.newKey(),
      body,
      attempts: 1,
      response: null,
    });
    this.file(this.path(scope, `operations/${id}`)).write(row);
    this.file(this.path(scope, "workspace")).write({ version: 1, scope, draft, prepared: true });
    return row;
  }

  /** A failed receipt write leaves the original prepared record available for replay. */
  confirm(session: DesktopSessionView, id: string, body: string, response: JsonHttpResponse): void {
    const scope = this.scope(session);
    const existing = this.operation(scope, id);
    if (existing === null || existing.body !== body)
      throw new ReceiveRecoveryConflict("恢复身份不匹配");
    const payload = CommandResponseSchema.parse(response.payload);
    // A later permission/validation rejection cannot prove an earlier lost request did not commit.
    // A definitive success also must never be overwritten by a later rejection.
    if (!payload.ok && (existing.attempts > 1 || existing.response?.payload.ok === true)) return;
    const row = OperationSchema.parse({ ...existing, response });
    this.file(this.path(scope, `operations/${id}`)).write(row);
  }
}
