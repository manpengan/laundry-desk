import {
  DesktopCommandExecuteResultSchema,
  DesktopOfflineResolveInputSchema,
  DesktopOfflineStatusResultSchema,
  createCommandError,
  type DesktopCommandExecuteResult,
  type DesktopOfflineResolveInput,
  type DesktopOfflineStatusResult,
} from "@laundry/contracts";

import type { PersistentEncryptedQueue } from "../queue/persistent-queue.js";
import type { OfflineConflictStore } from "./conflict-store.js";

export type OfflineQueueRejectionReason =
  "input_parse" | "mode" | "authority" | "sequence" | "envelope_parse" | "guard" | "enqueue";

export type OfflineAuthorityDiagnostic =
  | "authority_refresh_missing"
  | "authority_refresh_existing"
  | "authority_refresh_reused"
  | "authority_response_fail"
  | "authority_grant_fail"
  | "authority_trust_fail"
  | "authority_lease_fail"
  | "authority_provision_ok"
  | "authority_session_reject"
  | "continuity_external"
  | "continuity_clock"
  | "continuity_current_reject"
  | "continuity_session"
  | "continuity_blocked"
  | "continuity_sequence"
  | "continuity_guard"
  | "continuity_queue";

export type OfflineDiagnosticEvent =
  OfflineAuthorityDiagnostic | `queue_${OfflineQueueRejectionReason}`;
export type OfflineDiagnosticObserver = (event: OfflineDiagnosticEvent) => void;

export function offlineResourceFailure(): DesktopCommandExecuteResult {
  return Object.freeze({
    ok: false,
    error: createCommandError(
      "RESOURCE_UNAVAILABLE",
      Object.freeze({ kind: "reason", reason: "retry_later" }),
    ),
  });
}

export function offlineQueueRejected(
  observer: OfflineDiagnosticObserver | undefined,
  reason: OfflineQueueRejectionReason,
): DesktopCommandExecuteResult {
  observeOfflineDiagnostic(observer, `queue_${reason}`);
  return offlineResourceFailure();
}

export function observeOfflineDiagnostic(
  observer: OfflineDiagnosticObserver | undefined,
  event: OfflineDiagnosticEvent,
): void {
  try {
    observer?.(event);
  } catch {
    // Acceptance diagnostics must never change the fail-closed command result.
  }
}

export function offlineRuntimeStatus(
  queue: PersistentEncryptedQueue,
  conflicts: OfflineConflictStore,
): DesktopOfflineStatusResult {
  const status = queue.status();
  return DesktopOfflineStatusResultSchema.parse({
    ok: true,
    data: {
      pending_count: status.pendingCount,
      inflight_count: status.inflightCount,
      conflicts: conflicts.list(),
    },
  });
}

export function resolveOfflineRuntime(
  queue: PersistentEncryptedQueue,
  conflicts: OfflineConflictStore,
  input: DesktopOfflineResolveInput,
): DesktopOfflineStatusResult {
  const parsed = DesktopOfflineResolveInputSchema.parse(input);
  if (parsed.action === "discard") queue.ack(parsed.queue_id);
  conflicts.remove(parsed.queue_id);
  return offlineRuntimeStatus(queue, conflicts);
}

export function offlineQueuedSuccess(
  body: Readonly<Record<string, unknown>>,
  queueId: string,
): DesktopCommandExecuteResult {
  return DesktopCommandExecuteResultSchema.parse({
    ok: true,
    data: {
      execution: "executed",
      result: { ...body, offline_queued: true, queue_id: queueId },
    },
  });
}
