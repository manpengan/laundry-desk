import { createHttpAuthClient, type HttpAuthCredentialStore } from "../auth/HttpAuthClient.js";
import { createHttpCommandClient } from "../commands/command-client.js";
import { createHttpQueryClient } from "../commands/query-client.js";
import type { AppPorts, HealthResult } from "./types.js";
import { createHttpPhotoPort } from "./photo-port.js";

export type BrowserPortsOptions = Readonly<{
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  readCsrf?: () => string | null;
}>;

function defaultReadCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const match = /(?:^|;\s*)(?:__Host-laundry_csrf|laundry_csrf)=([^;]+)/u.exec(document.cookie);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isReadyEnvelope(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["ok", "data"]) || value.ok !== true) {
    return false;
  }
  return (
    isRecord(value.data) && hasExactKeys(value.data, ["status"]) && value.data.status === "ready"
  );
}

function unavailable(message: string): HealthResult {
  return Object.freeze({
    ok: false as const,
    error: Object.freeze({
      code: "SERVICE_UNAVAILABLE" as const,
      message,
    }),
  });
}

/**
 * Build the browser host's renderer-visible ports around one private credential closure.
 * The returned object exposes business capabilities only; credentials never enter React.
 */
export function createBrowserPorts(options: BrowserPortsOptions): AppPorts {
  const base = options.apiBaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const readCsrf = options.readCsrf ?? defaultReadCsrf;
  let accessToken: string | null = null;
  const credentialStore: HttpAuthCredentialStore = Object.freeze({
    getAccessToken: () => accessToken,
    replaceAccessToken: (next: string | null) => {
      accessToken = next;
    },
    readCsrf,
  });

  const auth = createHttpAuthClient({
    apiBaseUrl: base,
    fetchImpl,
    credentialStore,
  });
  const command = createHttpCommandClient({
    apiBaseUrl: base,
    fetchImpl,
    getAccessToken: credentialStore.getAccessToken,
    readCsrf: credentialStore.readCsrf,
  });
  const query = createHttpQueryClient({
    apiBaseUrl: base,
    fetchImpl,
    getAccessToken: credentialStore.getAccessToken,
    readCsrf: credentialStore.readCsrf,
  });

  return Object.freeze({
    auth,
    command,
    query,
    photo: createHttpPhotoPort({
      apiBaseUrl: base,
      fetchImpl,
      getAccessToken: credentialStore.getAccessToken,
      readCsrf: credentialStore.readCsrf,
    }),
    health: Object.freeze({
      async get(): Promise<HealthResult> {
        try {
          const response = await fetchImpl(`${base}/health`, {
            credentials: "include",
          });
          if (!response.ok) return unavailable("本地服务不可用");
          const body: unknown = await response.json();
          if (!isReadyEnvelope(body)) return unavailable("本地服务响应格式错误");
          return Object.freeze({
            ok: true as const,
            data: Object.freeze({ status: "ready" as const }),
          });
        } catch {
          return unavailable("无法连接本地服务");
        }
      },
    }),
  });
}
