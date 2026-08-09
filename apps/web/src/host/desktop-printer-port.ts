import type { LaundryDesktopBridge } from "./desktop-bridge.js";
import type {
  PrinterPort,
  PrinterResult,
  PrinterStatus,
  PrinterTestSubmission,
} from "./printer-port.js";

const QUEUE = /^[A-Za-z0-9_.-]{1,64}$/u;
const CUPS_JOB = /^[A-Za-z0-9_.-]{1,64}-[1-9][0-9]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function failed(message: string): PrinterResult<never> {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: "DESKTOP_BRIDGE_ERROR", message }),
  });
}

function readFailure(value: unknown): PrinterResult<never> | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "error"]) ||
    value.ok !== false ||
    !isRecord(value.error) ||
    !hasExactKeys(value.error, ["code", "message"]) ||
    typeof value.error.code !== "string" ||
    typeof value.error.message !== "string" ||
    value.error.code.length === 0 ||
    value.error.message.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code: value.error.code, message: value.error.message }),
  });
}

function readQueueList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  if (!value.every((queue) => typeof queue === "string" && QUEUE.test(queue))) return null;
  return Object.freeze([...value]);
}

function readStatusData(value: unknown): PrinterStatus | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["state", "configured_queue", "available_queues", "message"])
  ) {
    return null;
  }
  const queues = readQueueList(value.available_queues);
  const configured = value.configured_queue;
  if (
    (value.state !== "disabled" && value.state !== "ready" && value.state !== "unavailable") ||
    (configured !== null && (typeof configured !== "string" || !QUEUE.test(configured))) ||
    queues === null ||
    typeof value.message !== "string" ||
    value.message.length === 0
  ) {
    return null;
  }
  return Object.freeze({
    state: value.state,
    configuredQueue: configured,
    availableQueues: queues,
    message: value.message,
  });
}

function readStatusResult(value: unknown): PrinterResult<PrinterStatus> {
  const failure = readFailure(value);
  if (failure !== null) return failure;
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) {
    return failed("桌面打印机响应格式错误");
  }
  const data = readStatusData(value.data);
  return data === null
    ? failed("桌面打印机响应格式错误")
    : Object.freeze({ ok: true as const, data });
}

function readTestResult(value: unknown): PrinterResult<PrinterTestSubmission> {
  const failure = readFailure(value);
  if (failure !== null) return failure;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["ok", "data"]) ||
    value.ok !== true ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, [
      "queue",
      "cups_job_id",
      "payload_sha256",
      "bytes_written",
      "message",
    ])
  ) {
    return failed("桌面测试票响应格式错误");
  }
  const data = value.data;
  if (
    typeof data.queue !== "string" ||
    !QUEUE.test(data.queue) ||
    typeof data.cups_job_id !== "string" ||
    !CUPS_JOB.test(data.cups_job_id) ||
    typeof data.payload_sha256 !== "string" ||
    !SHA256.test(data.payload_sha256) ||
    typeof data.bytes_written !== "number" ||
    !Number.isSafeInteger(data.bytes_written) ||
    data.bytes_written < 1 ||
    typeof data.message !== "string" ||
    data.message.length === 0
  ) {
    return failed("桌面测试票响应格式错误");
  }
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      queue: data.queue,
      cupsJobId: data.cups_job_id,
      payloadSha256: data.payload_sha256,
      bytesWritten: data.bytes_written,
      message: data.message,
    }),
  });
}

async function invoke<T>(
  operation: () => Promise<unknown>,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse(await operation());
  } catch {
    return parse(null);
  }
}

export function createDesktopPrinterPort(
  bridge: NonNullable<LaundryDesktopBridge["printer"]>,
): PrinterPort {
  return Object.freeze({
    discover: () => invoke(bridge.discover, readStatusResult),
    status: () => invoke(bridge.status, readStatusResult),
    configure: (queue) => {
      if (queue !== null && !QUEUE.test(queue)) {
        return Promise.resolve(failed("CUPS 队列名称格式无效"));
      }
      return invoke(() => bridge.configure(Object.freeze({ queue })), readStatusResult);
    },
    testFixedTicket: () => invoke(bridge.test, readTestResult),
  });
}
