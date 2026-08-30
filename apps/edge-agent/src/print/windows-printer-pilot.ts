import { createHash } from "node:crypto";

import { PrintJobReferenceSchema, PrinterQueueNameSchema } from "@laundry/contracts";

import { buildPrinterSmokePayload } from "./printer-smoke.js";
import { createWindowsRawPrintPort, type RawPrintPort } from "./raw-print-port.js";

export type WindowsPrinterPilotResult = Readonly<{
  ok: boolean;
  mode: "discover" | "validate" | "print";
  queues: readonly string[];
  selected_queue?: string;
  cups_job_id?: string;
  payload_sha256?: string;
  bytes_written?: number;
  message: string;
}>;

export async function runWindowsPrinterPilot(
  input: Readonly<{ mode: "discover" | "validate" | "print"; queue?: string }>,
  port: RawPrintPort = createWindowsRawPrintPort(),
): Promise<WindowsPrinterPilotResult> {
  try {
    if (port.backend !== "windows_spooler") throw new Error("WINDOWS_PRINT_PORT_REQUIRED");
    const queues = await port.discoverQueues();
    if (input.mode === "discover") {
      return Object.freeze({
        ok: true,
        mode: "discover",
        queues,
        message: queues.length === 0 ? "未发现 Windows 打印队列" : "已发现 Windows 打印队列",
      });
    }
    const queue = input.queue ?? "";
    if (!PrinterQueueNameSchema.safeParse(queue).success || !queues.includes(queue)) {
      return Object.freeze({
        ok: false,
        mode: input.mode,
        queues,
        message: "所选 Windows 打印队列未安装",
      });
    }
    if (input.mode === "validate") {
      return Object.freeze({
        ok: true,
        mode: "validate",
        queues,
        selected_queue: queue,
        message: "Windows 打印队列已验证；未写入字节",
      });
    }
    const payload = buildPrinterSmokePayload("LAUNDRY Windows spooler pilot OK");
    const jobReference = PrintJobReferenceSchema.parse(await port.submitRaw(queue, payload));
    return Object.freeze({
      ok: true,
      mode: "print",
      queues,
      selected_queue: queue,
      cups_job_id: jobReference,
      payload_sha256: createHash("sha256").update(payload).digest("hex"),
      bytes_written: payload.byteLength,
      message: "RAW 测试票已提交 Windows 打印后台",
    });
  } catch {
    return Object.freeze({
      ok: false,
      mode: input.mode,
      queues: Object.freeze([]),
      message: "Windows 打印发现或提交失败；重试前请检查打印队列",
    });
  }
}
