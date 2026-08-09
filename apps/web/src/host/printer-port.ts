export type PrinterStatus = Readonly<{
  state: "disabled" | "ready" | "unavailable";
  configuredQueue: string | null;
  availableQueues: readonly string[];
  message: string;
}>;

export type PrinterTestSubmission = Readonly<{
  queue: string;
  cupsJobId: string;
  payloadSha256: string;
  bytesWritten: number;
  message: string;
}>;

export type PrinterFailure = Readonly<{
  code: string;
  message: string;
}>;

export type PrinterResult<T> =
  Readonly<{ ok: true; data: T }> | Readonly<{ ok: false; error: PrinterFailure }>;

export type PrinterPort = Readonly<{
  discover: () => Promise<PrinterResult<PrinterStatus>>;
  status: () => Promise<PrinterResult<PrinterStatus>>;
  configure: (queue: string | null) => Promise<PrinterResult<PrinterStatus>>;
  testFixedTicket: () => Promise<PrinterResult<PrinterTestSubmission>>;
}>;
