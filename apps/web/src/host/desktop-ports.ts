import type { CommandPort, CommandResult, QueryPort } from "../commands/types.js";
import {
  createDesktopAuthPort,
  createDesktopStaffDirectoryState,
  refreshDesktopStaffDirectory,
} from "./desktop-auth-port.js";
import type {
  DesktopCommandInput,
  DesktopQueryInput,
  LaundryDesktopBridge,
} from "./desktop-bridge.js";
import { createDesktopOfflinePort } from "./offline-port.js";
import { createDesktopPhotoPort } from "./desktop-photo-port.js";
import { createDesktopPrinterPort } from "./desktop-printer-port.js";
import { createDesktopResumePort } from "./desktop-resume-port.js";
import {
  HEALTH_FAILURE_MESSAGE,
  desktopBridgeError,
  desktopServiceUnavailable,
  readDesktopCommandResult,
  readDesktopHealthResult,
} from "./desktop-result-boundary.js";
import {
  EMPTY_BUSINESS_BODY,
  isOperationName,
  isSafeBusinessValue,
  readCommandOptions,
} from "./desktop-value-boundary.js";
import type { AppPorts, HealthPort, HealthResult } from "./types.js";

export type { LaundryDesktopBridge } from "./desktop-bridge.js";

function createCommandPort(bridge: LaundryDesktopBridge): CommandPort {
  return Object.freeze({
    async execute<T>(
      name: string,
      body?: unknown,
      options?: Readonly<{ confirmRef?: string }>,
    ): Promise<CommandResult<T>> {
      const parsedOptions = readCommandOptions(options);
      if (
        !isOperationName(name) ||
        (body !== undefined && !isSafeBusinessValue(body)) ||
        parsedOptions === null
      ) {
        return desktopBridgeError("桌面命令参数格式错误");
      }
      const input: DesktopCommandInput =
        parsedOptions.confirmRef === undefined
          ? Object.freeze({
              name,
              body: body === undefined ? EMPTY_BUSINESS_BODY : body,
            })
          : Object.freeze({ name, confirm_ref: parsedOptions.confirmRef });
      try {
        return readDesktopCommandResult<T>(await bridge.command.execute(input));
      } catch {
        return readDesktopCommandResult<T>(null);
      }
    },
  });
}

function createQueryPort(bridge: LaundryDesktopBridge): QueryPort {
  return Object.freeze({
    async execute<T>(name: string, body?: unknown): Promise<CommandResult<T>> {
      if (!isOperationName(name) || (body !== undefined && !isSafeBusinessValue(body))) {
        return desktopBridgeError("桌面查询参数格式错误");
      }
      const input: DesktopQueryInput = Object.freeze({
        name,
        body: body === undefined ? EMPTY_BUSINESS_BODY : body,
      });
      try {
        return readDesktopCommandResult<T>(await bridge.query.execute(input));
      } catch {
        return readDesktopCommandResult<T>(null);
      }
    },
  });
}

function createHealthPort(bridge: LaundryDesktopBridge): HealthPort {
  return Object.freeze({
    async get(): Promise<HealthResult> {
      try {
        return readDesktopHealthResult(await bridge.health.get());
      } catch {
        return desktopServiceUnavailable(HEALTH_FAILURE_MESSAGE);
      }
    },
  });
}

export function createDesktopPorts(bridge: LaundryDesktopBridge): AppPorts {
  const staffDirectory = createDesktopStaffDirectoryState();
  const auth = createDesktopAuthPort(bridge, staffDirectory);
  const baseResume = createDesktopResumePort(bridge.offline);
  const resume =
    baseResume === undefined
      ? undefined
      : Object.freeze({
          resume: async () => {
            const result = await baseResume.resume();
            if (!result.ok || result.mode === "offline_read_only") {
              staffDirectory.clear();
              return result;
            }
            if (await refreshDesktopStaffDirectory(bridge, staffDirectory)) return result;
            await auth.logout();
            return Object.freeze({ ok: false as const });
          },
        });
  return Object.freeze({
    auth,
    command: createCommandPort(bridge),
    query: createQueryPort(bridge),
    photo: createDesktopPhotoPort(bridge),
    offline: createDesktopOfflinePort(bridge.offline),
    ...(bridge.printer === undefined ? {} : { printer: createDesktopPrinterPort(bridge.printer) }),
    ...(resume === undefined ? {} : { resume }),
    health: createHealthPort(bridge),
  });
}
