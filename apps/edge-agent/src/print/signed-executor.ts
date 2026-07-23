/**
 * Signed print dispatch: verify one server ticket, serialize its physical port,
 * execute exactly once, then return an Edge-device-signed receipt.
 */
import type { KeyObject } from "node:crypto";

import { signReceipt, type SignedExecutionReceipt } from "../pairing/sign-receipt.js";
import { verifyCapabilityTicket, type TicketVerifyContext } from "../pairing/verify-ticket.js";
import { createExecutionGate, type ExecutionGate } from "./execution-gate.js";
import {
  DEFAULT_SAMPLE_TICKET,
  executeJob,
  type ExecuteJobOptions,
  type ExecuteJobResult,
} from "./executor.js";
import { getPrintJob, type PrintJobStore } from "./print-jobs.js";
import type { MockSpool } from "./mock-spool.js";
import type { TicketTemplateInput } from "./template-render.js";
import { createMockUsbPort, type UsbPrintPort } from "./usb-port.js";

export type SignedPrintExecution = Readonly<{
  execution: ExecuteJobResult;
  receipt: SignedExecutionReceipt;
}>;

export type SignedPrintRequest = Readonly<{
  capabilityTicket: unknown;
  store: PrintJobStore;
  spool: MockSpool;
  jobId: string;
  template?: TicketTemplateInput;
  executeOptions?: ExecuteJobOptions;
  mockJobId?: string;
}>;

export type SignedPrintExecutorOptions = Readonly<{
  ticketContext: TicketVerifyContext;
  devicePrivateKey: KeyObject;
}>;

function ticketError(reason: string): Error {
  return new Error(`print capability ticket rejected: ${reason}`);
}

function portKey(port: UsbPrintPort, fallback: string): string {
  return port.serialKey ?? `${port.kind}:${fallback}`;
}

/**
 * The process-local replay set intentionally survives job failures. Retrying needs
 * a new server job and a fresh nonce, so a captured ticket cannot print twice.
 */
export class SignedPrintExecutor {
  private readonly usedNonces = new Set<string>();
  private readonly gates = new Map<string, ExecutionGate>();

  constructor(private readonly options: SignedPrintExecutorOptions) {}

  async execute(request: SignedPrintRequest): Promise<SignedPrintExecution> {
    const verified = verifyCapabilityTicket(request.capabilityTicket, this.options.ticketContext);
    if (!verified.ok) throw ticketError(verified.error);
    if (verified.payload.action !== "print_job") throw ticketError("wrong_action");
    if (verified.payload.job_id !== request.jobId) throw ticketError("wrong_job");

    const job = getPrintJob(request.store, request.jobId);
    if (job === undefined) throw ticketError("unknown_job");
    if (job.status !== "queued") throw ticketError("job_not_queued");
    if (job.ticketNonce !== verified.payload.nonce) throw ticketError("wrong_nonce");
    if (this.usedNonces.has(verified.payload.nonce)) throw ticketError("replayed");
    this.usedNonces.add(verified.payload.nonce);

    const port = request.executeOptions?.usbPort ?? createMockUsbPort();
    const gate = this.gateFor(portKey(port, job.kind));
    return gate(() => this.executeWithPort(request, port));
  }

  private gateFor(key: string): ExecutionGate {
    const existing = this.gates.get(key);
    if (existing !== undefined) return existing;
    const created = createExecutionGate();
    this.gates.set(key, created);
    return created;
  }

  private async executeWithPort(
    request: SignedPrintRequest,
    usbPort: UsbPrintPort,
  ): Promise<SignedPrintExecution> {
    const execution = await executeJob(
      request.store,
      request.spool,
      request.jobId,
      request.template ?? DEFAULT_SAMPLE_TICKET,
      Object.freeze({ ...request.executeOptions, usbPort }),
      request.mockJobId,
    );
    return Object.freeze({
      execution,
      receipt: signReceipt(execution.receiptPayload, this.options.devicePrivateKey),
    });
  }
}

export function createSignedPrintExecutor(
  options: SignedPrintExecutorOptions,
): SignedPrintExecutor {
  return new SignedPrintExecutor(options);
}
