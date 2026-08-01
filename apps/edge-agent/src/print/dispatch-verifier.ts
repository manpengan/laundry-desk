import { createHash, type KeyObject } from "node:crypto";

import {
  canonicalizeForSignatureVerification,
  canonicalizePrintSnapshot,
  parseServerSignatureCapabilityTicketCandidate,
  PrintDispatchDataSchema,
  type CapabilityTicketPayload,
  type PrintSnapshot,
} from "@laundry/contracts";

import { APP_CAPABILITY_ORIGIN } from "../lib/security-prefs.js";
import { base64UrlToBytes } from "../pairing/device-keys.js";
import { verifyCapabilityTicket } from "../pairing/verify-ticket.js";

export type DispatchClaimTiming = Readonly<{
  requestStartedWallMs: number;
  requestStartedMonoMs: number;
  responseReceivedMonoMs: number;
}>;

export type DispatchVerifyContext = Readonly<{
  serverPublicKey: KeyObject;
  deviceId: string;
  staffId: string;
  printerKind: "xp58";
  timing: DispatchClaimTiming;
  monotonicNowMs: () => number;
  continuityTrusted: () => boolean;
  safetyMarginMs?: number;
}>;

export type VerifiedPrintDispatch = Readonly<{
  payload: Extract<CapabilityTicketPayload, Readonly<{ action: "print_job" }>>;
  snapshot: PrintSnapshot;
  capabilitySha256: string;
  localDeadlineMonoMs: number;
}>;

export class DispatchVerificationError extends Error {
  constructor(readonly code: string) {
    super(`print dispatch rejected: ${code}`);
    this.name = "DispatchVerificationError";
  }
}

function safeMonotonic(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function freezeSnapshot(snapshot: PrintSnapshot): PrintSnapshot {
  return Object.freeze({
    ...snapshot,
    lines: Object.freeze(snapshot.lines.map((line) => Object.freeze({ ...line }))),
    totals: Object.freeze({ ...snapshot.totals }),
    payment_methods: Object.freeze([...snapshot.payment_methods]),
  });
}

function digestSnapshot(snapshot: PrintSnapshot): string {
  return createHash("sha256").update(canonicalizePrintSnapshot(snapshot)).digest("hex");
}

function digestCapability(ticket: unknown): string {
  const candidate = parseServerSignatureCapabilityTicketCandidate(ticket);
  return createHash("sha256")
    .update(canonicalizeForSignatureVerification(candidate))
    .update(base64UrlToBytes(candidate.sig))
    .digest("hex");
}

function monotonicDeadline(
  payload: CapabilityTicketPayload,
  context: DispatchVerifyContext,
  nowMonoMs: number,
): number {
  const { requestStartedMonoMs, responseReceivedMonoMs } = context.timing;
  const safetyMarginMs = context.safetyMarginMs ?? 250;
  const lifetimeMs = Date.parse(payload.exp) - Date.parse(payload.issued_at);
  const roundTripMs = responseReceivedMonoMs - requestStartedMonoMs;
  if (
    !safeMonotonic(requestStartedMonoMs) ||
    !safeMonotonic(responseReceivedMonoMs) ||
    !safeMonotonic(nowMonoMs) ||
    responseReceivedMonoMs < requestStartedMonoMs ||
    nowMonoMs < responseReceivedMonoMs ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs <= 0 ||
    !Number.isSafeInteger(safetyMarginMs) ||
    safetyMarginMs < 0 ||
    roundTripMs + safetyMarginMs >= lifetimeMs
  ) {
    throw new DispatchVerificationError("monotonic_timing");
  }
  const deadline = requestStartedMonoMs + lifetimeMs - roundTripMs - safetyMarginMs;
  if (!Number.isFinite(deadline) || nowMonoMs >= deadline) {
    throw new DispatchVerificationError("expired_monotonic");
  }
  return deadline;
}

/** Verify signature, exact audiences/bindings, canonical snapshot hash and monotonic lifetime. */
export function verifyPrintDispatch(
  input: unknown,
  context: DispatchVerifyContext,
): VerifiedPrintDispatch {
  if (!context.continuityTrusted()) throw new DispatchVerificationError("continuity");
  const parsed = PrintDispatchDataSchema.safeParse(input);
  if (!parsed.success) throw new DispatchVerificationError("malformed");
  const nowMonoMs = context.monotonicNowMs();
  const elapsedMs = nowMonoMs - context.timing.requestStartedMonoMs;
  const structuralNowMs = Math.floor(context.timing.requestStartedWallMs + elapsedMs);
  if (!Number.isSafeInteger(structuralNowMs) || elapsedMs < 0) {
    throw new DispatchVerificationError("wall_anchor");
  }
  const verified = verifyCapabilityTicket(parsed.data.capability_ticket, {
    serverPublicKey: context.serverPublicKey,
    deviceId: context.deviceId,
    allowedOrigins: [APP_CAPABILITY_ORIGIN],
    nowMs: structuralNowMs,
  });
  if (!verified.ok) throw new DispatchVerificationError(verified.error);
  if (verified.payload.action !== "print_job") throw new DispatchVerificationError("wrong_action");
  if (verified.payload.staff_id !== context.staffId) {
    throw new DispatchVerificationError("wrong_staff");
  }
  if (verified.payload.origin !== APP_CAPABILITY_ORIGIN) {
    throw new DispatchVerificationError("wrong_origin");
  }
  if (verified.payload.printer_kind !== context.printerKind) {
    throw new DispatchVerificationError("wrong_printer");
  }
  const snapshot = freezeSnapshot(parsed.data.snapshot);
  if (digestSnapshot(snapshot) !== verified.payload.snapshot_sha256) {
    throw new DispatchVerificationError("wrong_snapshot");
  }
  return Object.freeze({
    payload: verified.payload,
    snapshot,
    capabilitySha256: digestCapability(parsed.data.capability_ticket),
    localDeadlineMonoMs: monotonicDeadline(verified.payload, context, nowMonoMs),
  });
}
