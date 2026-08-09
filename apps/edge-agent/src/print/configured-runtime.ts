import { isCupsQueueName } from "./cups-queue.js";
import {
  DISABLED_PRINTER_CONFIG,
  PrinterConfigStore,
  type PrinterConfig,
} from "./printer-config.js";
import type { MacPrinterPilotResult } from "./mac-printer-pilot.js";
import type { SignedPrintRuntime } from "./runtime.js";

export type PrinterRuntimeState = "disabled" | "ready" | "unavailable";

export type PrinterRuntimeStatus = Readonly<{
  state: PrinterRuntimeState;
  configured_queue: string | null;
  available_queues: readonly string[];
  message: string;
}>;

export type PrinterTestSubmission = Readonly<{
  queue: string;
  cups_job_id: string;
  payload_sha256: string;
  bytes_written: number;
  message: string;
}>;

export type PrinterManagerErrorCode =
  "INVALID_QUEUE" | "QUEUE_NOT_FOUND" | "UNAVAILABLE" | "TEST_FAILED";

export class PrinterManagerError extends Error {
  constructor(
    readonly code: PrinterManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrinterManagerError";
  }
}

type PrinterPilot = (
  input: Readonly<{ mode: "discover" | "validate" | "print"; queue?: string }>,
) => Promise<MacPrinterPilotResult>;

export type ConfiguredPrinterRuntimeOptions = Readonly<{
  store: PrinterConfigStore;
  createRuntime: (queue: string) => Promise<SignedPrintRuntime>;
  pilot: PrinterPilot;
  runtimeEnabled: boolean;
}>;

function stablePilotMessage(result: MacPrinterPilotResult): string {
  if (result.ok) return result.message;
  return "CUPS 打印机不可用，请刷新队列并检查本机打印设置";
}

/** Serializes queue changes with signed-runtime stop/start and fixed pilot tests. */
export class ConfiguredPrinterRuntime {
  private config: PrinterConfig = DISABLED_PRINTER_CONFIG;
  private runtime: SignedPrintRuntime | null = null;
  private tail: Promise<void> = Promise.resolve();
  private lastError: string | null = null;

  constructor(private readonly options: ConfiguredPrinterRuntimeOptions) {}

  initialize(bootstrapQueue?: string): Promise<PrinterRuntimeStatus> {
    return this.exclusive(async () => {
      let stored: PrinterConfig | null;
      try {
        stored = await this.options.store.read();
      } catch {
        this.lastError = "本机打印配置损坏；请由管理员重新选择队列";
        return this.readStatus();
      }

      if (stored === null) {
        try {
          this.config = await this.bootstrapConfig(bootstrapQueue);
        } catch (error) {
          this.config = DISABLED_PRINTER_CONFIG;
          this.lastError =
            error instanceof PrinterManagerError
              ? `${error.message}；旧环境配置未启用`
              : "旧环境打印配置无法验证，未启用打印";
        }
        await this.options.store.write(this.config);
      } else {
        this.config = stored;
      }
      await this.startConfiguredRuntime();
      return this.readStatus();
    });
  }

  status(): Promise<PrinterRuntimeStatus> {
    return this.exclusive(() => this.readStatus());
  }

  discover(): Promise<PrinterRuntimeStatus> {
    return this.status();
  }

  configure(queue: string | null): Promise<PrinterRuntimeStatus> {
    return this.exclusive(async () => {
      if (queue !== null) await this.assertInstalled(queue);
      await this.stopRuntime();
      const next = Object.freeze({ version: 1 as const, queue });
      await this.options.store.write(next);
      this.config = next;
      this.lastError = null;
      await this.startConfiguredRuntime();
      return this.readStatus();
    });
  }

  test(): Promise<PrinterTestSubmission> {
    return this.exclusive(async () => {
      const queue = this.config.queue;
      if (queue === null) {
        throw new PrinterManagerError("UNAVAILABLE", "请先选择并启用 CUPS 打印队列");
      }
      const result = await this.options.pilot({ mode: "print", queue });
      if (
        !result.ok ||
        result.selected_queue !== queue ||
        result.cups_job_id === undefined ||
        result.payload_sha256 === undefined ||
        result.bytes_written === undefined
      ) {
        throw new PrinterManagerError(
          "TEST_FAILED",
          "固定测试票未获 CUPS 可追踪任务；结果不代表已经出纸",
        );
      }
      return Object.freeze({
        queue,
        cups_job_id: result.cups_job_id,
        payload_sha256: result.payload_sha256,
        bytes_written: result.bytes_written,
        message: "固定测试票已提交 CUPS；请现场核对实际出纸",
      });
    });
  }

  invalidateContinuity(): void {
    this.runtime?.continuity.invalidate();
  }

  stop(): Promise<void> {
    return this.exclusive(() => this.stopRuntime());
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async bootstrapConfig(rawQueue: string | undefined): Promise<PrinterConfig> {
    const queue = rawQueue?.trim() ?? "";
    if (queue.length === 0) return DISABLED_PRINTER_CONFIG;
    await this.assertInstalled(queue);
    return Object.freeze({ version: 1, queue });
  }

  private async assertInstalled(queue: string): Promise<void> {
    if (!isCupsQueueName(queue)) {
      throw new PrinterManagerError("INVALID_QUEUE", "CUPS 队列名称格式无效");
    }
    const result = await this.options.pilot({ mode: "validate", queue });
    if (!result.ok || result.selected_queue !== queue) {
      throw new PrinterManagerError("QUEUE_NOT_FOUND", "所选 CUPS 队列未安装或当前不可用");
    }
  }

  private async startConfiguredRuntime(): Promise<void> {
    const queue = this.config.queue;
    if (queue === null || !this.options.runtimeEnabled) return;
    let created: SignedPrintRuntime | null = null;
    try {
      await this.assertInstalled(queue);
      created = await this.options.createRuntime(queue);
      await created.controller.start();
      this.runtime = created;
      this.lastError = null;
    } catch (error) {
      if (created !== null) {
        await created.controller.stop().catch(() => undefined);
      }
      this.runtime = null;
      this.lastError =
        error instanceof PrinterManagerError
          ? error.message
          : "签名打印运行时启动失败，未领取新的打印任务";
    }
  }

  private async stopRuntime(): Promise<void> {
    const current = this.runtime;
    if (current === null) return;
    await current.controller.stop();
    if (this.runtime === current) this.runtime = null;
  }

  private async readStatus(): Promise<PrinterRuntimeStatus> {
    const discovered = await this.options.pilot({ mode: "discover" });
    const availableQueues = discovered.ok ? discovered.queues : Object.freeze([]);
    const queue = this.config.queue;
    const installed = queue !== null && discovered.ok && availableQueues.includes(queue);
    const state: PrinterRuntimeState =
      queue === null ? "disabled" : this.runtime === null || !installed ? "unavailable" : "ready";
    const message =
      this.lastError ??
      (queue === null
        ? "尚未启用 CUPS 打印队列"
        : state === "ready"
          ? "CUPS 队列已启用，签名打印运行时正在工作"
          : discovered.ok
            ? "已选 CUPS 队列当前不可用，未领取新的打印任务"
            : stablePilotMessage(discovered));
    return Object.freeze({
      state,
      configured_queue: queue,
      available_queues: Object.freeze([...availableQueues]),
      message,
    });
  }
}
