import { createHash } from "node:crypto";

import { PrintJobReferenceSchema, PrinterQueueNameSchema } from "@laundry/contracts";

import { buildPrinterSmokePayload } from "./printer-smoke.js";
import {
  createWindowsRawPrintPort,
  RawPrintSubmissionError,
  type RawPrintPort,
} from "./raw-print-port.js";

export type WindowsPrinterPilotErrorCode =
  | "WINDOWS_PRINT_PORT_REQUIRED"
  | "WINDOWS_PRINT_DISCOVERY_FAILED"
  | "WINDOWS_PRINT_QUEUE_REQUIRED"
  | "WINDOWS_PRINT_QUEUE_AMBIGUOUS"
  | "WINDOWS_PRINT_QUEUE_INVALID"
  | "WINDOWS_PRINT_QUEUE_NOT_INSTALLED"
  | "WINDOWS_RAW_SUBMISSION_FAILED"
  | "WINDOWS_RAW_SUBMISSION_UNCERTAIN";

export type WindowsPrinterPilotResult = Readonly<{
  ok: boolean;
  mode: "discover" | "validate" | "print";
  queues: readonly string[];
  selected_queue?: string;
  cups_job_id?: string;
  payload_sha256?: string;
  bytes_written?: number;
  error_code?: WindowsPrinterPilotErrorCode;
  message: string;
}>;

function failedResult(
  mode: WindowsPrinterPilotResult["mode"],
  queues: readonly string[],
  errorCode: WindowsPrinterPilotErrorCode,
  message: string,
  selectedQueue?: string,
): WindowsPrinterPilotResult {
  return Object.freeze({
    ok: false,
    mode,
    queues,
    ...(selectedQueue === undefined ? {} : { selected_queue: selectedQueue }),
    error_code: errorCode,
    message,
  });
}

async function discoverInstalledQueues(port: RawPrintPort): Promise<readonly string[]> {
  const discovered = await port.discoverQueues();
  if (
    !Array.isArray(discovered) ||
    !discovered.every(
      (queue) => PrinterQueueNameSchema.safeParse(queue).success && port.isQueueName(queue),
    )
  ) {
    throw new Error("WINDOWS_PRINT_DISCOVERY_INVALID");
  }
  return Object.freeze([...discovered]);
}

type QueueSelection =
  | Readonly<{ ok: true; queue: string }>
  | Readonly<{ ok: false; result: WindowsPrinterPilotResult }>;

function rejectedSelection(result: WindowsPrinterPilotResult): QueueSelection {
  return Object.freeze({ ok: false, result });
}

function selectExplicitQueue(
  mode: "validate" | "print",
  queue: string | undefined,
  queues: readonly string[],
  port: RawPrintPort,
): QueueSelection {
  if (queue === undefined) {
    const code =
      queues.length === 0
        ? "WINDOWS_PRINT_QUEUE_NOT_INSTALLED"
        : queues.length > 1
          ? "WINDOWS_PRINT_QUEUE_AMBIGUOUS"
          : "WINDOWS_PRINT_QUEUE_REQUIRED";
    const message =
      queues.length === 0
        ? "未发现可选择的 Windows 打印队列"
        : queues.length > 1
          ? "发现多个 Windows 打印队列；必须明确选择一个队列"
          : "必须明确选择已发现的 Windows 打印队列";
    return rejectedSelection(failedResult(mode, queues, code, message));
  }
  if (!PrinterQueueNameSchema.safeParse(queue).success || !port.isQueueName(queue)) {
    return rejectedSelection(
      failedResult(
        mode,
        queues,
        "WINDOWS_PRINT_QUEUE_INVALID",
        "所选 Windows 打印队列名称格式无效",
      ),
    );
  }
  const matches = queues.filter((candidate) => candidate === queue).length;
  if (matches === 0) {
    return rejectedSelection(
      failedResult(
        mode,
        queues,
        "WINDOWS_PRINT_QUEUE_NOT_INSTALLED",
        "所选 Windows 打印队列未安装",
      ),
    );
  }
  if (matches !== 1) {
    return rejectedSelection(
      failedResult(
        mode,
        queues,
        "WINDOWS_PRINT_QUEUE_AMBIGUOUS",
        "所选 Windows 打印队列发现结果不唯一",
      ),
    );
  }
  return Object.freeze({ ok: true, queue });
}

async function submitFixedPayload(
  queue: string,
  queues: readonly string[],
  port: RawPrintPort,
): Promise<WindowsPrinterPilotResult> {
  const payload = buildPrinterSmokePayload("LAUNDRY Windows spooler pilot OK");
  try {
    const jobReference = PrintJobReferenceSchema.parse(await port.submitRaw(queue, payload));
    return Object.freeze({
      ok: true,
      mode: "print",
      queues,
      selected_queue: queue,
      cups_job_id: jobReference,
      payload_sha256: createHash("sha256").update(payload).digest("hex"),
      bytes_written: payload.byteLength,
      message: "RAW 测试票已提交 Windows 打印后台；不代表实体出纸",
    });
  } catch (error) {
    const definiteFailure = error instanceof RawPrintSubmissionError && error.outcome === "failed";
    return failedResult(
      "print",
      queues,
      definiteFailure ? "WINDOWS_RAW_SUBMISSION_FAILED" : "WINDOWS_RAW_SUBMISSION_UNCERTAIN",
      definiteFailure
        ? "Windows 打印后台明确拒绝测试票；未确认创建后台任务"
        : "Windows 打印后台结果不确定；可能已接单，禁止自动重试",
      queue,
    );
  }
}

export async function runWindowsPrinterPilot(
  input: Readonly<{ mode: "discover" | "validate" | "print"; queue?: string }>,
  port: RawPrintPort = createWindowsRawPrintPort(),
): Promise<WindowsPrinterPilotResult> {
  if (port.backend !== "windows_spooler") {
    return failedResult(
      input.mode,
      Object.freeze([]),
      "WINDOWS_PRINT_PORT_REQUIRED",
      "当前打印端口不是 Windows 打印后台",
    );
  }

  let queues: readonly string[];
  try {
    queues = await discoverInstalledQueues(port);
  } catch {
    return failedResult(
      input.mode,
      Object.freeze([]),
      "WINDOWS_PRINT_DISCOVERY_FAILED",
      "Windows 打印队列发现失败；未写入字节",
    );
  }

  if (input.mode === "discover") {
    return Object.freeze({
      ok: true,
      mode: "discover",
      queues,
      message: queues.length === 0 ? "未发现 Windows 打印队列" : "已发现 Windows 打印队列",
    });
  }
  const selection = selectExplicitQueue(input.mode, input.queue, queues, port);
  if (!selection.ok) return selection.result;
  if (input.mode === "validate") {
    return Object.freeze({
      ok: true,
      mode: "validate",
      queues,
      selected_queue: selection.queue,
      message: "Windows 打印队列已验证；未写入字节",
    });
  }
  return await submitFixedPayload(selection.queue, queues, port);
}
