import { DESKTOP_OPERATION_SCHEMAS } from "@laundry/contracts";

import { DESKTOP_IPC_CHANNELS } from "../lib/security-prefs.js";
import { isValidDesktopSender } from "../lib/sender.js";

export type DesktopFrameSurface = Readonly<{
  url: string;
}>;

export type DesktopIpcEventSurface = Readonly<{
  sender: Readonly<{
    id: number;
    mainFrame: DesktopFrameSurface;
  }>;
  senderFrame: DesktopFrameSurface | null;
}>;

type DesktopIpcHandler = (
  event: DesktopIpcEventSurface,
  ...arguments_: readonly unknown[]
) => Promise<unknown>;

export type DesktopIpcMainSurface = Readonly<{
  handle: (channel: string, handler: DesktopIpcHandler) => void;
}>;

export type DesktopOperationService = Readonly<{
  auth: Readonly<{
    login: (input: unknown) => Promise<unknown>;
    refresh: () => Promise<unknown>;
    pinChallenge: (input: unknown) => Promise<unknown>;
    pinVerify: (input: unknown) => Promise<unknown>;
    logout: () => Promise<unknown>;
  }>;
  command: Readonly<{
    execute: (input: unknown) => Promise<unknown>;
  }>;
  query: Readonly<{
    execute: (input: unknown) => Promise<unknown>;
  }>;
  photo: Readonly<{
    upload: (input: unknown) => Promise<unknown>;
  }>;
  health: Readonly<{
    get: () => Promise<unknown>;
  }>;
}>;

type OperationSchemaSurface = Readonly<{
  input: Readonly<{ parseAsync: (value: unknown) => Promise<unknown> }>;
  result: Readonly<{ parseAsync: (value: unknown) => Promise<unknown> }>;
}>;

export type DesktopHandlerError = Readonly<{
  channel: string;
  errorName: string;
}>;

export type DesktopOperationHandlerOptions = Readonly<{
  ipcMain: DesktopIpcMainSurface;
  service: DesktopOperationService;
  expectedWebContentsId: () => number | null;
  reportError?: (error: DesktopHandlerError) => void;
}>;

function assertExpectedSender(
  event: DesktopIpcEventSurface,
  expectedWebContentsId: number | null,
): void {
  const senderFrame = event.senderFrame;
  if (
    expectedWebContentsId === null ||
    senderFrame === null ||
    !isValidDesktopSender({
      senderUrl: senderFrame.url,
      senderWebContentsId: event.sender.id,
      expectedWebContentsId,
      isMainFrame: senderFrame === event.sender.mainFrame,
    })
  ) {
    throw new Error("Invalid desktop IPC sender");
  }
}

async function invokeOperation(
  schema: OperationSchemaSurface,
  arguments_: readonly unknown[],
  operation: (input: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (arguments_.length !== 1) {
    throw new Error("Desktop IPC expects exactly one argument");
  }
  const input = await schema.input.parseAsync(arguments_[0]);
  const result = await operation(input);
  return schema.result.parseAsync(result);
}

function defaultReportError(error: DesktopHandlerError): void {
  console.error("[edge-agent] desktop IPC rejected", error);
}

function registerOperation(
  options: DesktopOperationHandlerOptions,
  channel: string,
  schema: OperationSchemaSurface,
  operation: (input: unknown) => Promise<unknown>,
): void {
  options.ipcMain.handle(channel, async (event, ...arguments_) => {
    try {
      assertExpectedSender(event, options.expectedWebContentsId());
      return await invokeOperation(schema, arguments_, operation);
    } catch (error) {
      (options.reportError ?? defaultReportError)(
        Object.freeze({
          channel,
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      throw new Error("Desktop operation rejected");
    }
  });
}

/** Register the exact renderer capability surface; no generic dispatch channel exists. */
export function registerDesktopOperationHandlers(options: DesktopOperationHandlerOptions): void {
  const { service } = options;
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.auth.login,
    DESKTOP_OPERATION_SCHEMAS.auth.login,
    (input) => service.auth.login(input),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.auth.refresh,
    DESKTOP_OPERATION_SCHEMAS.auth.refresh,
    () => service.auth.refresh(),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.auth.pinChallenge,
    DESKTOP_OPERATION_SCHEMAS.auth.pinChallenge,
    (input) => service.auth.pinChallenge(input),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.auth.pinVerify,
    DESKTOP_OPERATION_SCHEMAS.auth.pinVerify,
    (input) => service.auth.pinVerify(input),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.auth.logout,
    DESKTOP_OPERATION_SCHEMAS.auth.logout,
    () => service.auth.logout(),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.command.execute,
    DESKTOP_OPERATION_SCHEMAS.command.execute,
    (input) => service.command.execute(input),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.query.execute,
    DESKTOP_OPERATION_SCHEMAS.query.execute,
    (input) => service.query.execute(input),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.photo.upload,
    DESKTOP_OPERATION_SCHEMAS.photo.upload,
    (input) => service.photo.upload(input),
  );
  registerOperation(
    options,
    DESKTOP_IPC_CHANNELS.health.get,
    DESKTOP_OPERATION_SCHEMAS.health.get,
    () => service.health.get(),
  );
}
