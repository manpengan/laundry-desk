import { createHash } from "node:crypto";

import {
  ReconciliationDayResultSchema,
  ReconciliationExportResultSchema,
  BusinessDateSchema,
  createCommandError,
} from "@laundry/contracts";
import { businessDayAt } from "@laundry/domain";

import type { CommandHandler, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { buildReconciliationCsv } from "./csv.js";
import type { ReconciliationDayResult } from "@laundry/contracts";
import type { ReconciliationHandlerDeps } from "./types.js";

function asRecord(parsed: unknown): Readonly<Record<string, unknown>> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function resolveReconciliationBusinessDate(
  value: unknown,
  deps: Pick<ReconciliationHandlerDeps, "timeZone" | "rolloverHour" | "now">,
): string {
  if (value === undefined) {
    return businessDayAt(deps.now?.() ?? new Date(), deps.timeZone, deps.rolloverHour ?? 0)
      .business_date;
  }
  const parsed = BusinessDateSchema.safeParse(value);
  if (!parsed.success) {
    throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
  }
  return parsed.data;
}

async function readSummary(
  ctx: Parameters<CommandHandler>[0],
  deps: ReconciliationHandlerDeps,
): Promise<ReconciliationDayResult> {
  const input = asRecord(ctx.parsed);
  const now = deps.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new HandlerCommandError(createCommandError("TRANSACTION_FAILED"));
  }
  const businessDate = resolveReconciliationBusinessDate(input.business_date, {
    ...deps,
    now: () => now,
  });
  const snapshot = await deps.source.readDay({
    client: ctx.client,
    tenant: ctx.tenant,
    businessDate,
  });
  return ReconciliationDayResultSchema.parse({
    ...snapshot,
    business_date: businessDate,
    generated_at: now.toISOString(),
  });
}

function dayGetHandler(deps: ReconciliationHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> =>
    Object.freeze({
      result: await readSummary(ctx, deps),
    });
}

function exportHandler(deps: ReconciliationHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const summary = await readSummary(ctx, deps);
    const csv = buildReconciliationCsv(summary);
    const contentSha256 = createHash("sha256").update(csv, "utf8").digest("hex");
    const result = ReconciliationExportResultSchema.parse({
      filename: `reconciliation-${summary.business_date}.csv`,
      content_sha256: contentSha256,
      csv,
    });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "reconciliation_export",
        entityId: summary.business_date,
        afterJson: JSON.stringify({
          business_date: summary.business_date,
          filename: result.filename,
          content_sha256: result.content_sha256,
          bytes: Buffer.byteLength(result.csv, "utf8"),
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "reconciliation.exported",
          payload: Object.freeze({
            business_date: summary.business_date,
            filename: result.filename,
            content_sha256: result.content_sha256,
          }),
        }),
      ]),
    });
  };
}

function edgeConflictDiscardHandler(deps: ReconciliationHandlerDeps): CommandHandler {
  return async (ctx): Promise<HandlerOutcome> => {
    const input = asRecord(ctx.parsed);
    if (
      typeof input.queue_id !== "string" ||
      typeof input.reason !== "string" ||
      input.confirm !== "DISCARD"
    ) {
      throw new HandlerCommandError(createCommandError("VALIDATION_FAILED"));
    }
    const exists = await deps.edgeConflicts.hasDiscardableConflict(
      ctx.client,
      ctx.tenant,
      input.queue_id,
    );
    if (!exists) {
      throw new HandlerCommandError(createCommandError("RESOURCE_UNAVAILABLE"));
    }
    return Object.freeze({
      result: Object.freeze({ queue_id: input.queue_id, discarded: true as const }),
      audit: Object.freeze({
        entity: "edge_replay_conflict",
        entityId: input.queue_id,
        afterJson: JSON.stringify({
          queue_id: input.queue_id,
          disposition: "discarded",
          reason: input.reason,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "edge.conflict_discarded",
          payload: Object.freeze({
            queue_id: input.queue_id,
          }),
        }),
      ]),
    });
  };
}

export function registerReconciliationCommandHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: ReconciliationHandlerDeps,
): void {
  registry.registerHandler("reconciliation.export", exportHandler(deps));
  registry.registerHandler("edge.conflict.discard", edgeConflictDiscardHandler(deps));
}

export function registerReconciliationQueryHandlers(
  registry: Readonly<{ registerHandler: (name: string, handler: CommandHandler) => void }>,
  deps: ReconciliationHandlerDeps,
): void {
  registry.registerHandler("reconciliation.day.get", dayGetHandler(deps));
}

export function createReconciliationHandlers(
  deps: ReconciliationHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "reconciliation.day.get": dayGetHandler(deps),
    "reconciliation.export": exportHandler(deps),
    "edge.conflict.discard": edgeConflictDiscardHandler(deps),
  });
}
