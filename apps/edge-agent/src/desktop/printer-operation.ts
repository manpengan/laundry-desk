import { z } from "zod";

import {
  PrinterManagerError,
  type ConfiguredPrinterRuntime,
  type PrinterRuntimeStatus,
  type PrinterTestSubmission,
} from "../print/configured-runtime.js";
import { isCupsQueueName } from "../print/cups-queue.js";

const EmptyInputSchema = z.strictObject({});
const QueueSchema = z.string().refine(isCupsQueueName, "Invalid CUPS queue name");
const MessageSchema = z.string().min(1).max(512);

export const DesktopPrinterStatusSchema = z.strictObject({
  state: z.enum(["disabled", "ready", "unavailable"]),
  configured_queue: QueueSchema.nullable(),
  available_queues: z.array(QueueSchema).max(128),
  message: MessageSchema,
});

const DesktopPrinterTestDataSchema = z.strictObject({
  queue: QueueSchema,
  cups_job_id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}-[1-9][0-9]*$/u),
  payload_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes_written: z
    .number()
    .int()
    .positive()
    .max(64 * 1_024),
  message: MessageSchema,
});

const DesktopPrinterFailureSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: z.enum([
      "UNAUTHENTICATED",
      "FORBIDDEN",
      "INVALID_QUEUE",
      "QUEUE_NOT_FOUND",
      "UNAVAILABLE",
      "TEST_FAILED",
      "INTERNAL",
    ]),
    message: MessageSchema,
  }),
});

const statusResult = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: DesktopPrinterStatusSchema }),
  DesktopPrinterFailureSchema,
]);
const testResult = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), data: DesktopPrinterTestDataSchema }),
  DesktopPrinterFailureSchema,
]);

export const DESKTOP_PRINTER_OPERATIONS = Object.freeze({
  discover: Object.freeze({ input: EmptyInputSchema, result: statusResult }),
  status: Object.freeze({ input: EmptyInputSchema, result: statusResult }),
  configure: Object.freeze({
    input: z.strictObject({ queue: QueueSchema.nullable() }),
    result: statusResult,
  }),
  test: Object.freeze({
    input: z.strictObject({ confirm: z.literal("PRINT_FIXED_TEST") }),
    result: testResult,
  }),
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DesktopPrinterStatus = DeepReadonly<z.output<typeof DesktopPrinterStatusSchema>>;
export type DesktopPrinterConfigureInput = DeepReadonly<
  z.output<(typeof DESKTOP_PRINTER_OPERATIONS)["configure"]["input"]>
>;
export type DesktopPrinterStatusResult = DeepReadonly<z.output<typeof statusResult>>;
export type DesktopPrinterTestResult = DeepReadonly<z.output<typeof testResult>>;

type SessionAuthority = Readonly<{ role: "admin" | "staff" }>;

export type DesktopPrinterService = Readonly<{
  discover: () => Promise<DesktopPrinterStatusResult>;
  status: () => Promise<DesktopPrinterStatusResult>;
  configure: (input: unknown) => Promise<DesktopPrinterStatusResult>;
  test: (input: unknown) => Promise<DesktopPrinterTestResult>;
}>;

type FailureCode = z.output<typeof DesktopPrinterFailureSchema>["error"]["code"];

function failure(code: FailureCode, message: string) {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, message }),
  });
}

async function authorize(
  currentSession: () => SessionAuthority | null | Promise<SessionAuthority | null>,
) {
  const session = await currentSession();
  if (session === null) return failure("UNAUTHENTICATED", "请先登录管理员账号");
  if (session.role !== "admin") return failure("FORBIDDEN", "只有管理员可以修改本机打印设置");
  return null;
}

function mapFailure(error: unknown) {
  if (error instanceof PrinterManagerError) return failure(error.code, error.message);
  return failure("INTERNAL", "本机打印操作失败，未执行未确认的打印动作");
}

/** Admin-only device-local printer surface; no path, argv, raw bytes or generic shell input. */
export function createDesktopPrinterService(
  options: Readonly<{
    manager: ConfiguredPrinterRuntime;
    currentSession: () => SessionAuthority | null | Promise<SessionAuthority | null>;
    mutationsEnabled: boolean;
  }>,
): DesktopPrinterService {
  const read = async (operation: () => Promise<PrinterRuntimeStatus>) => {
    const denied = await authorize(options.currentSession);
    if (denied !== null) return denied;
    try {
      return Object.freeze({ ok: true as const, data: await operation() });
    } catch (error) {
      return mapFailure(error);
    }
  };
  const rejectRecovery = () =>
    options.mutationsEnabled
      ? null
      : failure("UNAVAILABLE", "恢复模式禁止修改打印设置或提交测试票");

  return Object.freeze({
    discover: () => read(() => options.manager.discover()),
    status: () => read(() => options.manager.status()),
    configure: async (input: unknown) => {
      const denied = (await authorize(options.currentSession)) ?? rejectRecovery();
      if (denied !== null) return denied;
      const parsed = DESKTOP_PRINTER_OPERATIONS.configure.input.parse(input);
      try {
        return Object.freeze({
          ok: true as const,
          data: await options.manager.configure(parsed.queue),
        });
      } catch (error) {
        return mapFailure(error);
      }
    },
    test: async (input: unknown) => {
      const denied = (await authorize(options.currentSession)) ?? rejectRecovery();
      if (denied !== null) return denied;
      DESKTOP_PRINTER_OPERATIONS.test.input.parse(input);
      try {
        const data: PrinterTestSubmission = await options.manager.test();
        return Object.freeze({ ok: true as const, data });
      } catch (error) {
        return mapFailure(error);
      }
    },
  });
}
