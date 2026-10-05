import { randomUUID } from "node:crypto";
import { DESKTOP_MAX_JSON_BYTES, type DesktopSessionView } from "@laundry/contracts";
import type { DesktopHttpTransportDependencies } from "./http-transport-ports.js";
import { isRecord, type JsonHttpResponse } from "./http-transport-support.js";
import { createDesktopRequest, type DesktopRequestOptions } from "./request-builder.js";

const MAX_UNCONFIRMED_COMMANDS = 128;
const ENCODER = new TextEncoder();

function definitive(response: JsonHttpResponse): boolean {
  const { statusCode, payload } = response;
  if (!isRecord(payload)) return false;
  if (statusCode >= 200 && statusCode < 300 && payload.ok === true) return true;
  return (
    statusCode < 500 &&
    payload.ok === false &&
    isRecord(payload.error) &&
    typeof payload.error.code === "string" &&
    !["TRANSACTION_FAILED", "EVENT_DISPATCH_FAILED", "RESOURCE_UNAVAILABLE"].includes(
      payload.error.code,
    )
  );
}

/** Main-process-owned retry keys. Renderer never selects headers or transport identity. */
export function createDesktopJsonRequester(
  request: DesktopHttpTransportDependencies["request"],
  currentSession: () => DesktopSessionView | null,
  newKey: () => string = randomUUID,
) {
  let activeScope: string | null = null;
  let pending = new Map<string, string>();
  let confirmations = new Map<string, string>();
  return async (
    method: "GET" | "POST",
    path: string,
    options?: DesktopRequestOptions,
  ): Promise<JsonHttpResponse | null> => {
    try {
      const session = currentSession()?.session;
      const scope =
        session === undefined
          ? null
          : JSON.stringify([
              session.org_id,
              session.store_id,
              session.staff_id,
              session.session_id,
              session.session_version,
            ]);
      if (scope !== activeScope) {
        activeScope = scope;
        pending = new Map();
        confirmations = new Map();
      }
      const confirmationRef =
        isRecord(options?.body) && typeof options.body.confirm_ref === "string"
          ? options.body.confirm_ref
          : null;
      const owned = confirmationRef === null ? pending : confirmations;
      const ownedConfirmations = confirmations;
      const original = createDesktopRequest(method, path, options);
      const fingerprint =
        method === "POST" && path.startsWith("/v1/commands/") && scope !== null
          ? `${path}\n${confirmationRef === null ? `${options?.operationId ?? ""}\n${String(original.body ?? "")}` : confirmationRef}`
          : null;
      let key: string | undefined;
      if (fingerprint !== null) {
        key = owned.get(fingerprint);
        if (key === undefined) {
          if (owned.size >= MAX_UNCONFIRMED_COMMANDS) return null;
          key = newKey();
          owned.set(fingerprint, key);
        }
      }
      const response = await request(
        key === undefined
          ? original
          : Object.freeze({
              ...original,
              headers: Object.freeze({ ...original.headers, "Idempotency-Key": key }),
            }),
      );
      if (
        !Number.isInteger(response.statusCode) ||
        response.statusCode < 100 ||
        response.statusCode > 599 ||
        ENCODER.encode(response.bodyText).byteLength > DESKTOP_MAX_JSON_BYTES
      )
        return null;
      const result = Object.freeze({
        statusCode: response.statusCode,
        payload: JSON.parse(response.bodyText) as unknown,
      });
      if (
        fingerprint !== null &&
        key !== undefined &&
        definitive(result) &&
        owned.get(fingerprint) === key
      ) {
        const failure =
          isRecord(result.payload) && isRecord(result.payload.error) ? result.payload.error : null;
        const detail = isRecord(failure?.detail) ? failure.detail : null;
        if (
          (failure?.code === "POLICY_STEP_UP_REQUIRED" ||
            failure?.code === "POLICY_CONFIRMATION_REQUIRED") &&
          typeof detail?.confirm_ref === "string"
        ) {
          // Confirmation is a second hop of the same server-bound operation.
          if (ownedConfirmations.size >= MAX_UNCONFIRMED_COMMANDS) return null;
          ownedConfirmations.set(`${path}\n${detail.confirm_ref}`, key);
        }
        owned.delete(fingerprint);
      }
      return result;
    } catch {
      return null;
    }
  };
}
