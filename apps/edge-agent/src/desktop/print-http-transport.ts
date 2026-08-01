import { performance } from "node:perf_hooks";

import {
  PrintDispatchClaimRequestSchema,
  PrintDispatchClaimResponseSchema,
  PrintExecutionReceiptRequestSchema,
  PrintReceiptResponseSchema,
  type DesktopSessionView,
  type PrintDispatchData,
  type PrintReceiptSettlement,
} from "@laundry/contracts";

import type { SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import type { DispatchClaimTiming } from "../print/dispatch-verifier.js";
import {
  AUTHENTICATION_FAILURE,
  RESOURCE_FAILURE,
  type AsyncSchema,
  type DesktopFailure,
  type ResultEnvelope,
} from "./http-transport-support.js";

const CLAIM_PATH = "/api/v2/edge/print/claim";
const RECEIPT_PATH = "/api/v2/edge/print/receipt";

export type PrintClaimOutcome =
  | DesktopFailure
  | Readonly<{
      ok: true;
      data: PrintDispatchData | null;
      session: DesktopSessionView;
      timing: DispatchClaimTiming;
    }>;

export type PrintReceiptOutcome =
  DesktopFailure | Readonly<{ ok: true; data: PrintReceiptSettlement }>;

export type PrintProtectedExecutor = <T extends ResultEnvelope>(
  schema: AsyncSchema<T>,
  path: string,
  body: Readonly<Record<string, unknown>> | Uint8Array,
  contentType?: string,
  retryAuthentication?: boolean,
) => Promise<T | DesktopFailure>;

export type EdgePrintHttpTransport = Readonly<{
  claim: () => Promise<PrintClaimOutcome>;
  receipt: (receipt: SignedExecutionReceipt) => Promise<PrintReceiptOutcome>;
}>;

type PrintHttpTransportDependencies = Readonly<{
  executeProtected: PrintProtectedExecutor;
  currentSession: () => DesktopSessionView | null;
  wallNowMs?: () => number;
  monotonicNowMs?: () => number;
}>;

function sameSession(left: DesktopSessionView, right: DesktopSessionView): boolean {
  const a = left.session;
  const b = right.session;
  return (
    a.session_id === b.session_id &&
    a.session_version === b.session_version &&
    a.org_id === b.org_id &&
    a.store_id === b.store_id &&
    a.staff_id === b.staff_id &&
    a.device_id === b.device_id &&
    a.permission_version === b.permission_version &&
    left.role === right.role
  );
}

function validClock(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Main-process-only authenticated transport; never exported through preload/IPC. */
export function createEdgePrintHttpTransport(
  dependencies: PrintHttpTransportDependencies,
): EdgePrintHttpTransport {
  const wallNowMs = dependencies.wallNowMs ?? Date.now;
  const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());

  const claim = async (): Promise<PrintClaimOutcome> => {
    const session = dependencies.currentSession();
    if (session === null) return AUTHENTICATION_FAILURE;
    const request = PrintDispatchClaimRequestSchema.parse({
      supported_printer_kinds: ["xp58"],
    });
    const requestStartedWallMs = wallNowMs();
    const requestStartedMonoMs = monotonicNowMs();
    if (!validClock(requestStartedWallMs) || !validClock(requestStartedMonoMs)) {
      return RESOURCE_FAILURE;
    }
    const response = await dependencies.executeProtected(
      PrintDispatchClaimResponseSchema,
      CLAIM_PATH,
      request,
    );
    const responseReceivedMonoMs = monotonicNowMs();
    const current = dependencies.currentSession();
    if (
      !validClock(responseReceivedMonoMs) ||
      responseReceivedMonoMs < requestStartedMonoMs ||
      current === null ||
      !sameSession(session, current)
    ) {
      return RESOURCE_FAILURE;
    }
    if (!response.ok) return response;
    return Object.freeze({
      ok: true as const,
      data: response.data,
      session: current,
      timing: Object.freeze({
        requestStartedWallMs,
        requestStartedMonoMs,
        responseReceivedMonoMs,
      }),
    });
  };

  const receipt = async (signed: SignedExecutionReceipt): Promise<PrintReceiptOutcome> => {
    const request = PrintExecutionReceiptRequestSchema.safeParse({ receipt: signed });
    if (!request.success) return RESOURCE_FAILURE;
    return dependencies.executeProtected(PrintReceiptResponseSchema, RECEIPT_PATH, request.data);
  };

  return Object.freeze({ claim, receipt });
}
