import { createHash } from "node:crypto";

import { groupPickupReminders, renderPickupReminder } from "@laundry/domain";

import type { TenantContext } from "../db/types.js";
import type {
  NotificationAttemptSettlement,
  NotificationDeliveryClaim,
  NotificationProvider,
  NotificationProviderSendResult,
  NotificationWorkerStore,
} from "./delivery-types.js";

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const MAX_RECORDED_PROVIDER_COST_CENTS = 100_000;
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_PROVIDER_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

export type NotificationWorkerStep = Readonly<{
  kind: "idle" | "accepted" | "retry_wait" | "manual_required" | "stale_lease";
  delivery_id: string | null;
  error_code: string | null;
}>;

export type NotificationWorkerOptions = Readonly<{
  store: NotificationWorkerStore;
  provider: NotificationProvider;
  tenant: TenantContext;
  workerId: string;
  now?: () => Date;
  providerTimeoutMs?: number;
}>;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function validNow(options: NotificationWorkerOptions): Date {
  const value = options.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid notification worker clock");
  return value;
}

function renderClaim(claim: NotificationDeliveryClaim): string | null {
  const group = groupPickupReminders([claim.candidate], "order")[0];
  if (group === undefined) return null;
  const message = renderPickupReminder(claim.template.body, group);
  return sha256(message) === claim.expectedMessageSha256 ? message : null;
}

async function sendWithTimeout(
  options: NotificationWorkerOptions,
  claim: NotificationDeliveryClaim,
  message: string,
  timeoutMs: number,
  startedAt: Date,
): Promise<NotificationProviderSendResult> {
  const controller = new AbortController();
  const wallStartedAt = Date.now();
  let interruptedBy: "PROVIDER_TIMEOUT" | "PROVIDER_LEASE_LOST" | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let interrupt: (code: "PROVIDER_TIMEOUT" | "PROVIDER_LEASE_LOST") => void = () => undefined;
  const logicalNow = (): Date => new Date(startedAt.getTime() + Date.now() - wallStartedAt);
  const interruption = new Promise<Readonly<{ kind: "interrupted"; errorCode: string }>>(
    (resolve) => {
      interrupt = (code) => {
        if (interruptedBy !== null) return;
        interruptedBy = code;
        if (heartbeat !== null) clearInterval(heartbeat);
        controller.abort(new Error(`notification provider interrupted: ${code}`));
        resolve(Object.freeze({ kind: "interrupted" as const, errorCode: code }));
      };
    },
  );
  const timeout = setTimeout(() => {
    interrupt("PROVIDER_TIMEOUT");
  }, timeoutMs);
  heartbeat = setInterval(
    () => {
      if (interruptedBy !== null) return;
      void options.store
        .renewLease(options.tenant, claim.deliveryId, claim.leaseToken, logicalNow())
        .then((renewed) => {
          if (renewed || interruptedBy !== null) return;
          interrupt("PROVIDER_LEASE_LOST");
        })
        .catch(() => {
          if (interruptedBy !== null) return;
          interrupt("PROVIDER_LEASE_LOST");
        });
    },
    Math.max(25, Math.min(5_000, Math.floor(timeoutMs / 2))),
  );
  heartbeat.unref();
  const providerCall = Promise.resolve()
    .then(() =>
      options.provider.send({
        deliveryId: claim.deliveryId,
        recipient: claim.candidate.customer_phone,
        message,
        timeoutMs,
        deadline: new Date(startedAt.getTime() + timeoutMs),
        signal: controller.signal,
      }),
    )
    .then(
      (result) => Object.freeze({ kind: "result" as const, result }),
      () => Object.freeze({ kind: "failed" as const }),
    );
  try {
    const completed = await Promise.race([providerCall, interruption]);
    if (completed.kind === "result") return completed.result;
    return Object.freeze({
      outcome: "uncertain",
      errorCode:
        completed.kind === "interrupted"
          ? completed.errorCode
          : (interruptedBy ?? "PROVIDER_CALL_FAILED"),
      providerRef: null,
      costCents: 0,
    });
  } finally {
    clearTimeout(timeout);
    if (heartbeat !== null) clearInterval(heartbeat);
  }
}

function validatedResult(
  provider: NotificationProvider,
  result: unknown,
): NotificationProviderSendResult {
  const invalid = (): NotificationProviderSendResult =>
    Object.freeze({
      outcome: "permanent_failure",
      errorCode: "PROVIDER_RESULT_INVALID",
      providerRef: null,
      costCents: 0,
    });
  try {
    if (typeof result !== "object" || result === null) return invalid();
    const candidate = result as Record<string, unknown>;
    const outcome = candidate.outcome;
    const errorCode = candidate.errorCode;
    const providerRef = candidate.providerRef;
    const costCents = candidate.costCents;
    if (
      !["accepted", "transient_failure", "permanent_failure", "uncertain"].includes(
        String(outcome),
      ) ||
      !Number.isSafeInteger(costCents) ||
      (costCents as number) < 0 ||
      (costCents as number) > MAX_RECORDED_PROVIDER_COST_CENTS
    ) {
      return invalid();
    }
    if (outcome === "accepted") {
      if (
        errorCode !== null ||
        typeof providerRef !== "string" ||
        providerRef.length < 1 ||
        providerRef.length > 512
      ) {
        return invalid();
      }
    } else if (
      typeof errorCode !== "string" ||
      !SAFE_ERROR.test(errorCode) ||
      providerRef !== null ||
      costCents !== 0
    ) {
      return invalid();
    }
    if (outcome === "uncertain" && !provider.supportsIdempotency) {
      return Object.freeze({
        outcome: "permanent_failure",
        errorCode: "PROVIDER_IDEMPOTENCY_UNPROVEN",
        providerRef: null,
        costCents: 0,
      });
    }
    return Object.freeze({
      outcome: outcome as NotificationProviderSendResult["outcome"],
      errorCode: errorCode as string | null,
      providerRef: providerRef as string | null,
      costCents: costCents as number,
    });
  } catch {
    return invalid();
  }
}

function preflightFailure(
  options: NotificationWorkerOptions,
  claim: NotificationDeliveryClaim,
): string | null {
  try {
    if (
      !SAFE_PROVIDER_CODE.test(options.provider.code) ||
      !["software_only", "external"].includes(options.provider.assurance) ||
      !["sms", "wechat"].includes(options.provider.channel) ||
      !Number.isSafeInteger(options.provider.maxBatchSize) ||
      options.provider.maxBatchSize < 1 ||
      typeof options.provider.supportsIdempotency !== "boolean" ||
      typeof options.provider.supportsCancellation !== "boolean" ||
      typeof options.provider.supportsReceipts !== "boolean" ||
      !Number.isSafeInteger(options.provider.unitCostCents) ||
      options.provider.unitCostCents < 0 ||
      !Number.isSafeInteger(options.provider.maxBatchCostCents) ||
      options.provider.maxBatchCostCents < 0 ||
      typeof options.provider.send !== "function"
    ) {
      return "PROVIDER_CONTRACT_INVALID";
    }
  } catch {
    return "PROVIDER_CONTRACT_INVALID";
  }
  if (!options.provider.supportsIdempotency) {
    return "PROVIDER_IDEMPOTENCY_UNPROVEN";
  }
  if (!options.provider.supportsCancellation) {
    return "PROVIDER_CANCELLATION_UNPROVEN";
  }
  if (!options.provider.supportsReceipts) {
    return "PROVIDER_RECEIPTS_UNPROVEN";
  }
  if (
    claim.providerCode !== options.provider.code ||
    claim.assurance !== options.provider.assurance ||
    claim.template.channel !== options.provider.channel
  ) {
    return "PROVIDER_CONFIGURATION_CHANGED";
  }
  if (claim.batchRecipientCount > options.provider.maxBatchSize) {
    return "PROVIDER_BATCH_LIMIT_EXCEEDED";
  }
  const currentEstimatedCost = options.provider.unitCostCents * claim.batchRecipientCount;
  if (
    !Number.isSafeInteger(currentEstimatedCost) ||
    currentEstimatedCost !== claim.batchEstimatedCostCents ||
    claim.maxCostCents > options.provider.maxBatchCostCents
  ) {
    return "PROVIDER_CONFIGURATION_CHANGED";
  }
  if (claim.reservedCostCents !== options.provider.unitCostCents) {
    return "COST_LIMIT_EXCEEDED";
  }
  return null;
}

async function settle(
  options: NotificationWorkerOptions,
  claim: NotificationDeliveryClaim,
  result: NotificationProviderSendResult,
  startedAt: Date,
  completedAt: Date,
): Promise<NotificationWorkerStep> {
  const settlement: NotificationAttemptSettlement = Object.freeze({
    deliveryId: claim.deliveryId,
    leaseToken: claim.leaseToken,
    attemptNo: claim.attemptNo,
    outcome: result.outcome,
    errorCode: result.errorCode,
    providerRefSha256: result.providerRef === null ? null : sha256(result.providerRef),
    costCents: result.costCents,
    startedAt,
    completedAt,
  });
  const kind = await options.store.settleAttempt(options.tenant, settlement);
  return Object.freeze({
    kind,
    delivery_id: claim.deliveryId,
    error_code: kind === "accepted" ? null : result.errorCode,
  });
}

export async function runNotificationWorkerOnce(
  options: NotificationWorkerOptions,
): Promise<NotificationWorkerStep> {
  const startedAt = validNow(options);
  await options.store.expireAccepted(options.tenant, startedAt, 50);
  const claim = await options.store.claimNext(options.tenant, options.workerId, startedAt);
  if (claim === null) {
    return Object.freeze({ kind: "idle", delivery_id: null, error_code: null });
  }
  const message = renderClaim(claim);
  const preflight = message === null ? "TARGET_SNAPSHOT_CHANGED" : preflightFailure(options, claim);
  let result: NotificationProviderSendResult;
  if (message === null || preflight !== null) {
    result = Object.freeze({
      outcome: "permanent_failure" as const,
      errorCode: preflight ?? "TARGET_SNAPSHOT_CHANGED",
      providerRef: null,
      costCents: 0,
    });
  } else {
    result = validatedResult(
      options.provider,
      await sendWithTimeout(
        options,
        claim,
        message,
        options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        startedAt,
      ),
    );
  }
  return settle(options, claim, result, startedAt, validNow(options));
}

export async function drainNotificationQueue(
  options: NotificationWorkerOptions,
  limit: number,
): Promise<readonly NotificationWorkerStep[]> {
  const outcomes: NotificationWorkerStep[] = [];
  for (let index = 0; index < limit; index += 1) {
    const outcome = await runNotificationWorkerOnce(options);
    if (outcome.kind === "idle") break;
    outcomes.push(outcome);
  }
  return Object.freeze(outcomes);
}
