import {
  CommandResponseSchema,
  StaffCredentialsCompleteRequestSchema,
  StaffCredentialsCompleteResponseSchema,
} from "@laundry/contracts";
import { z } from "zod";

import {
  parseInput,
  parseOutput,
  VALIDATION_FAILURE,
  type AsyncSchema,
  type DesktopFailure,
} from "./http-transport-support.js";

const DesktopStaffCredentialCompleteSuccessSchema = z.strictObject({
  ok: z.literal(true),
  data: StaffCredentialsCompleteResponseSchema,
});

export const DesktopStaffCredentialCompleteResultSchema = z.discriminatedUnion("ok", [
  DesktopStaffCredentialCompleteSuccessSchema,
  CommandResponseSchema.options[1],
]);

export const DESKTOP_STAFF_CREDENTIAL_OPERATION = Object.freeze({
  input: StaffCredentialsCompleteRequestSchema,
  result: DesktopStaffCredentialCompleteResultSchema,
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type DesktopStaffCredentialCompleteInput = DeepReadonly<
  z.output<typeof StaffCredentialsCompleteRequestSchema>
>;
export type DesktopStaffCredentialCompleteResult = DeepReadonly<
  z.output<typeof DesktopStaffCredentialCompleteResultSchema>
>;

type ProtectedCredentialRequest = (
  schema: AsyncSchema<DesktopStaffCredentialCompleteResult>,
  path: string,
  body: Readonly<Record<string, unknown>>,
) => Promise<DesktopStaffCredentialCompleteResult | DesktopFailure>;

/** Keep the credential body in the main-process request closure only. */
export function createStaffCredentialCompleteOperation(
  executeProtected: ProtectedCredentialRequest,
): (input: unknown) => Promise<DesktopStaffCredentialCompleteResult> {
  return async (input: unknown): Promise<DesktopStaffCredentialCompleteResult> => {
    const parsedInput = await parseInput(DESKTOP_STAFF_CREDENTIAL_OPERATION.input, input);
    if (!parsedInput.valid) {
      return parseOutput(DesktopStaffCredentialCompleteResultSchema, VALIDATION_FAILURE);
    }
    return executeProtected(
      DesktopStaffCredentialCompleteResultSchema,
      "/api/v2/auth/staff/credentials/complete",
      Object.freeze({ ...parsedInput.data }),
    );
  };
}
