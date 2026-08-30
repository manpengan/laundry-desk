import {
  CommandResponseSchema,
  DesktopRefreshInputSchema,
  DesktopStaffDirectorySchema,
} from "@laundry/contracts";
import { z } from "zod";

import {
  AUTHENTICATION_FAILURE,
  NO_SUCCESS_DATA,
  RESOURCE_FAILURE,
  isSameSession,
  isSuccessStatus,
  parseHttpOutput,
  parseOutput,
  projectStaffDirectory,
  readSuccessData,
  type AuthState,
  type DesktopFailure,
  type JsonHttpResponse,
} from "./http-transport-support.js";

const DesktopStaffDirectorySuccessSchema = z.strictObject({
  ok: z.literal(true),
  data: DesktopStaffDirectorySchema,
});

export const DesktopStaffDirectoryResultSchema = z.discriminatedUnion("ok", [
  DesktopStaffDirectorySuccessSchema,
  CommandResponseSchema.options[1],
]);

export const DESKTOP_STAFF_DIRECTORY_OPERATION = Object.freeze({
  input: DesktopRefreshInputSchema,
  result: DesktopStaffDirectoryResultSchema,
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DesktopStaffDirectoryResult = DeepReadonly<
  z.output<typeof DesktopStaffDirectoryResultSchema>
>;

export async function readDesktopStaffDirectoryResponse(
  response: JsonHttpResponse | null,
): Promise<DesktopStaffDirectoryResult | DesktopFailure> {
  if (response === null || !isSuccessStatus(response.statusCode)) {
    return parseHttpOutput(DesktopStaffDirectoryResultSchema, response);
  }
  const data = readSuccessData(response.payload);
  const projected = data === NO_SUCCESS_DATA ? null : projectStaffDirectory(data);
  return parseOutput(
    DesktopStaffDirectoryResultSchema,
    projected === null ? RESOURCE_FAILURE : { ok: true, data: projected },
  );
}

export function createStaffDirectoryGetOperation(
  dependencies: Readonly<{
    currentState: () => AuthState | null;
    request: (accessToken: string) => Promise<JsonHttpResponse | null>;
  }>,
): () => Promise<DesktopStaffDirectoryResult> {
  return async (): Promise<DesktopStaffDirectoryResult> => {
    const state = dependencies.currentState();
    if (state === null) {
      return parseOutput(DesktopStaffDirectoryResultSchema, AUTHENTICATION_FAILURE);
    }
    const result = await readDesktopStaffDirectoryResponse(
      await dependencies.request(state.accessToken),
    );
    const current = dependencies.currentState();
    return current !== null && isSameSession(state, current)
      ? parseOutput(DesktopStaffDirectoryResultSchema, result)
      : parseOutput(DesktopStaffDirectoryResultSchema, RESOURCE_FAILURE);
  };
}
