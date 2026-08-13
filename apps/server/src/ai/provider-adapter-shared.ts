import type { AiProviderEvent, AiProviderToolName } from "./streaming-provider.js";
import { ProviderAdapterError, type ProviderFailureCode } from "./provider-types.js";

export const PROVIDER_TIMEOUT_MS = 10_000;
export const MAX_DISCOVERED_MODELS = 200;
export type ExternalProviderToolName =
  "synthetic_lookup" | "business_summary" | "records_search" | "procedure_troubleshoot";

export function toExternalToolName(name: string | undefined): ExternalProviderToolName {
  if (name === "synthetic.lookup") return "synthetic_lookup";
  if (name === "business.summary") return "business_summary";
  if (name === "records.search") return "records_search";
  if (name === "procedure.troubleshoot") return "procedure_troubleshoot";
  throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
}

export function fromExternalToolName(name: string): AiProviderToolName {
  if (name === "synthetic_lookup") return "synthetic.lookup";
  if (name === "business_summary") return "business.summary";
  if (name === "records_search") return "records.search";
  if (name === "procedure_troubleshoot") return "procedure.troubleshoot";
  throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
}

export function credentialText(credential: Buffer): string {
  if (
    credential.byteLength < 8 ||
    credential.byteLength > 8_192 ||
    credential.some((byte) => byte < 0x21 || byte > 0x7e)
  ) {
    throw new ProviderAdapterError("PROVIDER_AUTH_REJECTED");
  }
  return credential.toString("ascii");
}

const EVENT_CODES: Readonly<
  Record<ProviderFailureCode, Extract<AiProviderEvent, { type: "error" }>["code"]>
> = Object.freeze({
  PROVIDER_AUTH_REJECTED: "provider_auth_rejected",
  PROVIDER_RATE_LIMITED: "provider_rate_limited",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  PROVIDER_TIMEOUT: "provider_timeout",
  PROVIDER_ABORTED: "provider_aborted",
  PROVIDER_RESPONSE_INVALID: "provider_response_invalid",
  PROVIDER_RESPONSE_TOO_LARGE: "provider_response_too_large",
  NETWORK_POLICY_DENIED: "provider_network_denied",
  NETWORK_ERROR: "provider_failed",
});

export function providerErrorEvent(error: unknown): AiProviderEvent {
  const code = error instanceof ProviderAdapterError ? EVENT_CODES[error.code] : "provider_failed";
  return Object.freeze({ type: "error" as const, code });
}

export function normalizeProviderError(error: unknown): ProviderAdapterError {
  return error instanceof ProviderAdapterError
    ? error
    : new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
}

export function parseToolArguments(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid tool arguments");
    }
    return parsed;
  } catch {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_INVALID");
  }
}

export function boundedModels<T>(
  values: readonly T[],
  map: (value: T) => Readonly<{ modelId: string; displayName: string }>,
): readonly Readonly<{ modelId: string; displayName: string }>[] {
  if (values.length > MAX_DISCOVERED_MODELS) {
    throw new ProviderAdapterError("PROVIDER_RESPONSE_TOO_LARGE");
  }
  return Object.freeze(values.map(map));
}
