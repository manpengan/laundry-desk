import type { LaundryDesktopBridge } from "./desktop-ports.js";

export type HostSelection =
  Readonly<{ kind: "browser" }> | Readonly<{ kind: "desktop"; bridge: LaundryDesktopBridge }>;

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function readOwnPlainRecord(
  value: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !isPlainRecord(descriptor.value)) {
    return null;
  }
  return descriptor.value;
}

function hasExactFunctionSurface(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  return (
    hasExactOwnKeys(value, expected) &&
    expected.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
      );
    })
  );
}

function isDesktopBridge(value: unknown): value is LaundryDesktopBridge {
  if (
    !isPlainRecord(value) ||
    !hasExactOwnKeys(value, ["auth", "command", "query", "photo", "health"])
  ) {
    return false;
  }
  const auth = readOwnPlainRecord(value, "auth");
  const command = readOwnPlainRecord(value, "command");
  const query = readOwnPlainRecord(value, "query");
  const photo = readOwnPlainRecord(value, "photo");
  const health = readOwnPlainRecord(value, "health");
  return (
    auth !== null &&
    command !== null &&
    query !== null &&
    photo !== null &&
    health !== null &&
    hasExactFunctionSurface(auth, ["login", "refresh", "pinChallenge", "pinVerify", "logout"]) &&
    hasExactFunctionSurface(command, ["execute"]) &&
    hasExactFunctionSurface(query, ["execute"]) &&
    hasExactFunctionSurface(photo, ["upload"]) &&
    hasExactFunctionSurface(health, ["get"])
  );
}

function parseHostUrl(href: string): URL {
  try {
    return new URL(href);
  } catch {
    throw new Error("宿主地址无效");
  }
}

function hasTrustedDesktopAuthority(url: URL): boolean {
  return (
    url.protocol === "app:" &&
    url.hostname.toLowerCase() === "local" &&
    url.username === "" &&
    url.password === "" &&
    url.port === ""
  );
}

/**
 * Selects the renderer transport from normalized URL fields only.
 *
 * HTTP(S) always uses browser ports. The desktop bridge is reachable only from
 * the exact app://local authority and is validated before it enters the host.
 */
export function selectHost(href: string, bridge: unknown): HostSelection {
  const url = parseHostUrl(href);

  if (url.protocol === "http:" || url.protocol === "https:") {
    return Object.freeze({ kind: "browser" as const });
  }

  if (url.protocol !== "app:") {
    throw new Error("不支持的 Web 宿主协议");
  }

  if (!hasTrustedDesktopAuthority(url)) {
    throw new Error("不受信任的桌面应用来源");
  }

  if (!isDesktopBridge(bridge)) {
    throw new Error("桌面安全桥未就绪");
  }

  return Object.freeze({ kind: "desktop" as const, bridge });
}
