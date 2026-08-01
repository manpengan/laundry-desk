import type {
  PrintDispatchClaimRequest,
  PrintDispatchData,
  PrintExecutionReceiptRequest,
  PrintReceiptSettlement,
} from "@laundry/contracts";

export type PrintDispatchSession = Readonly<{
  orgId: string;
  storeId: string;
  staffId: string;
  deviceId: string;
}>;

export type PrintDispatchService = Readonly<{
  claim(
    session: PrintDispatchSession,
    request: PrintDispatchClaimRequest,
  ): Promise<PrintDispatchData | null>;
  settle(
    session: PrintDispatchSession,
    request: PrintExecutionReceiptRequest,
  ): Promise<PrintReceiptSettlement>;
}>;

export type PrintDispatchErrorCode =
  "device_unavailable" | "binding" | "signature" | "sequence" | "collision";

export class PrintDispatchError extends Error {
  constructor(readonly code: PrintDispatchErrorCode) {
    super(`Edge print dispatch rejected: ${code}`);
    this.name = "PrintDispatchError";
  }
}
