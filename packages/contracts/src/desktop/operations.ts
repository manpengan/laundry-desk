import { z } from "zod";

import {
  AccessSessionResponseSchema,
  EmptyBodySchema,
  LoginRequestSchema,
  LogoutResponseSchema,
  PinChallengeRequestSchema,
  PinChallengeResponseSchema,
  PinVerifyRequestSchema,
  PinVerifyResponseSchema,
} from "../auth/operation-schemas.js";
import { snapshotPlainData, type PlainData } from "../auth/plain-data.js";
import {
  M2_CONTRACT_COMMAND_NAMES,
  M2_CONTRACT_DEFINITIONS,
  M2_CONTRACT_QUERY_NAMES,
} from "../commands/catalog.js";
import { PhotoContentTypeSchema, PhotoUploadDataSchema } from "../commands/photo.js";
import { CommandResponseSchema } from "../envelope/responses.js";
import { ConfirmReferenceSchema } from "../envelope/wire-payload.js";
import type { CommandDefinition, QueryDefinition } from "../registry/definitions.js";
import { parseContractInput } from "../registry/definitions.js";

/** Hard IPC JSON limits, applied before registry input validation or renderer projection. */
export const DESKTOP_MAX_JSON_BYTES = 256 * 1_024;
export const DESKTOP_MAX_JSON_DEPTH = 32;
export const DESKTOP_MAX_JSON_NODES = 10_000;
export const DESKTOP_MAX_STAFF_DIRECTORY_SIZE = 500;
export const DESKTOP_MAX_PHOTO_BYTES = 8 * 1_024 * 1_024;

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

type PlainDataRecord = Readonly<Record<string, PlainData>>;

const JsonTextEncoder = new TextEncoder();
const isPlainDataArray = (value: PlainData): value is readonly PlainData[] => Array.isArray(value);

const jsonByteLength = (value: PlainData): number =>
  JsonTextEncoder.encode(JSON.stringify(value)).byteLength;

const snapshotBoundedJson = (value: unknown, label: string): PlainData => {
  const snapshot = snapshotPlainData(value, label);
  if (jsonByteLength(snapshot) > DESKTOP_MAX_JSON_BYTES) {
    throw new TypeError(`${label} exceeds the desktop JSON byte limit`);
  }
  return snapshot;
};

const DesktopJsonObjectSchema = z.unknown().transform((value, context): PlainDataRecord => {
  try {
    const snapshot = snapshotBoundedJson(value, "desktop JSON object");
    if (snapshot === null || isPlainDataArray(snapshot) || typeof snapshot !== "object") {
      throw new TypeError("desktop JSON input must be a plain object");
    }
    return snapshot;
  } catch {
    context.addIssue({
      code: "custom",
      message: "Desktop JSON input must be a bounded plain object",
    });
    return z.NEVER;
  }
});

const validateBoundedJson = (
  value: unknown,
  context: z.core.$RefinementCtx<unknown>,
  path: readonly PropertyKey[],
): void => {
  try {
    snapshotBoundedJson(value, "desktop JSON result");
  } catch {
    context.addIssue({
      code: "custom",
      message: "Desktop JSON result exceeds the complexity limit",
      path: path.map(String),
    });
  }
};

const INTERNAL_DESKTOP_COMMANDS = new Set(["photo.register", "photo.delete"]);
const commandDefinitions = Object.freeze(
  M2_CONTRACT_DEFINITIONS.filter(
    (definition): definition is CommandDefinition<z.ZodObject> =>
      definition.kind === "command" && !INTERNAL_DESKTOP_COMMANDS.has(definition.name),
  ),
);
const queryDefinitions = Object.freeze(
  M2_CONTRACT_DEFINITIONS.filter(
    (definition): definition is QueryDefinition<z.ZodObject> => definition.kind === "query",
  ),
);

const assertRegistryProjection = (
  label: string,
  names: readonly string[],
  definitions: readonly (CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>)[],
): void => {
  const definitionNames = definitions.map((definition) => definition.name);
  const definitionNameSet = new Set(definitionNames);
  if (
    names.length !== definitionNames.length ||
    names.some((name) => !definitionNameSet.has(name)) ||
    new Set(names).size !== names.length ||
    definitionNameSet.size !== definitionNames.length ||
    names.some((name) => name.startsWith("identity."))
  ) {
    throw new TypeError(`${label} must exactly project the non-identity M2 registry`);
  }
};

const desktopCommandNames = Object.freeze(
  M2_CONTRACT_COMMAND_NAMES.filter((name) => !INTERNAL_DESKTOP_COMMANDS.has(name)),
);

assertRegistryProjection("Desktop command names", desktopCommandNames, commandDefinitions);
assertRegistryProjection("Desktop query names", M2_CONTRACT_QUERY_NAMES, queryDefinitions);

const commandDefinitionByName = new Map(
  commandDefinitions.map((definition) => [definition.name, definition] as const),
);
const queryDefinitionByName = new Map(
  queryDefinitions.map((definition) => [definition.name, definition] as const),
);

export const DesktopCommandNameSchema = z.enum(desktopCommandNames);
export const DesktopQueryNameSchema = z.enum(M2_CONTRACT_QUERY_NAMES);

const addDefinitionInputIssues = async (
  definition: CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>,
  body: PlainDataRecord,
  context: z.core.$RefinementCtx<unknown>,
): Promise<void> => {
  try {
    await parseContractInput(definition, body);
    return;
  } catch (error) {
    const issues =
      error instanceof z.ZodError
        ? error.issues
        : [{ message: "Registry input validation failed", path: [] }];
    issues.forEach((issue) => {
      context.addIssue({
        code: "custom",
        message: `Body does not match ${definition.name}: ${issue.message}`,
        path: ["body", ...issue.path.map(String)],
      });
    });
  }
};

const DesktopDirectCommandExecuteInputSchema = z
  .strictObject({
    name: DesktopCommandNameSchema,
    body: DesktopJsonObjectSchema,
  })
  .superRefine(async (input, context) => {
    const definition = commandDefinitionByName.get(input.name);
    if (definition === undefined) {
      context.addIssue({
        code: "custom",
        message: "Command is absent from the M2 desktop registry",
        path: ["name"],
      });
      return;
    }
    await addDefinitionInputIssues(definition, input.body, context);
  });

const DesktopConfirmedCommandExecuteInputSchema = z.strictObject({
  name: DesktopCommandNameSchema,
  confirm_ref: ConfirmReferenceSchema,
});

export const DesktopCommandExecuteInputSchema = z.union([
  DesktopDirectCommandExecuteInputSchema,
  DesktopConfirmedCommandExecuteInputSchema,
]);

const DesktopQueryExecuteInputBaseSchema = z.strictObject({
  name: DesktopQueryNameSchema,
  body: DesktopJsonObjectSchema,
});

export const DesktopQueryExecuteInputSchema = DesktopQueryExecuteInputBaseSchema.superRefine(
  async (input, context) => {
    const definition = queryDefinitionByName.get(input.name);
    if (definition === undefined) {
      context.addIssue({
        code: "custom",
        message: "Query is absent from the M2 desktop registry",
        path: ["name"],
      });
      return;
    }
    await addDefinitionInputIssues(definition, input.body, context);
  },
);

const DesktopBoundedCommandResponseSchema = z.preprocess((value, context) => {
  try {
    return snapshotBoundedJson(value, "desktop command result");
  } catch {
    context.addIssue({
      code: "custom",
      message: "Desktop command result exceeds the complexity limit",
    });
    return z.NEVER;
  }
}, CommandResponseSchema);

export const DesktopCommandExecuteResultSchema = DesktopBoundedCommandResponseSchema;
export const DesktopQueryExecuteResultSchema = DesktopBoundedCommandResponseSchema;

/**
 * Login form data is the A5 request without device_id. The main process owns and injects the
 * stable device identity, so renderer code cannot impersonate another desktop device.
 */
export const DesktopLoginInputSchema = LoginRequestSchema.omit({ device_id: true });
export const DesktopRefreshInputSchema = EmptyBodySchema;
export const DesktopPinChallengeInputSchema = PinChallengeRequestSchema;
export const DesktopPinVerifyInputSchema = PinVerifyRequestSchema;
export const DesktopLogoutInputSchema = EmptyBodySchema;
export const DesktopHealthGetInputSchema = EmptyBodySchema;

/** Credential-free projection derived directly from the authoritative access-session response. */
export const DesktopSessionViewSchema = AccessSessionResponseSchema.omit({
  access_token: true,
  token_type: true,
  expires_in: true,
  storage: true,
}).superRefine((view, context) => validateBoundedJson(view, context, []));

export const DesktopStaffDirectoryEntrySchema = z.strictObject({
  staff_id: z.uuid(),
  display_name: z.string().min(1).max(256),
  role: AccessSessionResponseSchema.shape.role,
});

export const DesktopStaffDirectorySchema = z
  .array(DesktopStaffDirectoryEntrySchema)
  .max(DESKTOP_MAX_STAFF_DIRECTORY_SIZE)
  .superRefine((entries, context) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.staff_id)) {
        context.addIssue({
          code: "custom",
          message: "Desktop staff directory contains a duplicate staff_id",
          path: [index, "staff_id"],
        });
      }
      seen.add(entry.staff_id);
    });
  });

const DesktopLoginDataSchema = z.strictObject({
  session_view: DesktopSessionViewSchema,
  staff_directory: DesktopStaffDirectorySchema,
});
const DesktopStepUpProofSchema = PinVerifyResponseSchema.options[1];
const DesktopPinVerifyDataSchema = z.union([DesktopSessionViewSchema, DesktopStepUpProofSchema]);
const DesktopHealthReadySchema = z.strictObject({ status: z.literal("ready") });
const DesktopFailureResultSchema = CommandResponseSchema.options[1];

const createDesktopResultSchema = <TData extends z.ZodType>(data: TData) =>
  z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), data }),
    DesktopFailureResultSchema,
  ]);

export const DesktopLoginResultSchema = createDesktopResultSchema(DesktopLoginDataSchema);
export const DesktopRefreshResultSchema = createDesktopResultSchema(DesktopSessionViewSchema);
export const DesktopPinChallengeResultSchema = createDesktopResultSchema(
  PinChallengeResponseSchema,
);
export const DesktopPinVerifyResultSchema = createDesktopResultSchema(DesktopPinVerifyDataSchema);
export const DesktopLogoutResultSchema = createDesktopResultSchema(LogoutResponseSchema);
export const DesktopHealthGetResultSchema = createDesktopResultSchema(DesktopHealthReadySchema);
export const DesktopPhotoUploadInputSchema = z
  .strictObject({
    upload_id: z.uuid(),
    order_id: z.uuid(),
    garment_id: z.uuid(),
    kind: z.enum(["receive", "defect", "ready", "other"]),
    content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    bytes: z.instanceof(Uint8Array),
    taken_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .superRefine((input, context) => {
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > DESKTOP_MAX_PHOTO_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Desktop photo bytes exceed the allowed range",
        path: ["bytes"],
      });
    }
  });
export const DesktopPhotoUploadResultSchema = createDesktopResultSchema(PhotoUploadDataSchema);
export const DesktopPhotoReadInputSchema = z.strictObject({
  photo_id: z.uuid(),
  variant: z.enum(["thumbnail", "original"]),
});
const DesktopPhotoBinaryDataSchema = z
  .strictObject({
    content_type: PhotoContentTypeSchema,
    bytes: z.instanceof(Uint8Array),
  })
  .superRefine((data, context) => {
    if (data.bytes.byteLength < 1 || data.bytes.byteLength > DESKTOP_MAX_PHOTO_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Desktop photo response exceeds the allowed range",
        path: ["bytes"],
      });
    }
  });
export const DesktopPhotoReadResultSchema = createDesktopResultSchema(DesktopPhotoBinaryDataSchema);
export const DesktopPhotoDeleteInputSchema = z.strictObject({
  photo_id: z.uuid(),
  delete_id: z.uuid(),
});
export const DesktopPhotoDeleteResultSchema = createDesktopResultSchema(PhotoUploadDataSchema);

const operation = <TInput extends z.ZodType, TResult extends z.ZodType>(
  input: TInput,
  result: TResult,
) => Object.freeze({ input, result });

/**
 * The complete renderer capability registry. No generic invoke/fetch operation and no transport
 * controls exist in this shape.
 */
export const DESKTOP_OPERATION_SCHEMAS = Object.freeze({
  auth: Object.freeze({
    login: operation(DesktopLoginInputSchema, DesktopLoginResultSchema),
    refresh: operation(DesktopRefreshInputSchema, DesktopRefreshResultSchema),
    pinChallenge: operation(DesktopPinChallengeInputSchema, DesktopPinChallengeResultSchema),
    pinVerify: operation(DesktopPinVerifyInputSchema, DesktopPinVerifyResultSchema),
    logout: operation(DesktopLogoutInputSchema, DesktopLogoutResultSchema),
  }),
  command: Object.freeze({
    execute: operation(DesktopCommandExecuteInputSchema, DesktopCommandExecuteResultSchema),
  }),
  query: Object.freeze({
    execute: operation(DesktopQueryExecuteInputSchema, DesktopQueryExecuteResultSchema),
  }),
  photo: Object.freeze({
    upload: operation(DesktopPhotoUploadInputSchema, DesktopPhotoUploadResultSchema),
    read: operation(DesktopPhotoReadInputSchema, DesktopPhotoReadResultSchema),
    delete: operation(DesktopPhotoDeleteInputSchema, DesktopPhotoDeleteResultSchema),
  }),
  health: Object.freeze({
    get: operation(DesktopHealthGetInputSchema, DesktopHealthGetResultSchema),
  }),
});

export type DesktopCommandName = z.output<typeof DesktopCommandNameSchema>;
export type DesktopQueryName = z.output<typeof DesktopQueryNameSchema>;
export type DesktopCommandExecuteInput = DeepReadonly<
  z.output<typeof DesktopCommandExecuteInputSchema>
>;
export type DesktopCommandExecuteResult = DeepReadonly<
  z.output<typeof DesktopCommandExecuteResultSchema>
>;
export type DesktopQueryExecuteInput = DeepReadonly<
  z.output<typeof DesktopQueryExecuteInputSchema>
>;
export type DesktopQueryExecuteResult = DeepReadonly<
  z.output<typeof DesktopQueryExecuteResultSchema>
>;
export type DesktopLoginInput = DeepReadonly<z.output<typeof DesktopLoginInputSchema>>;
export type DesktopLoginResult = DeepReadonly<z.output<typeof DesktopLoginResultSchema>>;
export type DesktopRefreshResult = DeepReadonly<z.output<typeof DesktopRefreshResultSchema>>;
export type DesktopPinChallengeResult = DeepReadonly<
  z.output<typeof DesktopPinChallengeResultSchema>
>;
export type DesktopPinVerifyResult = DeepReadonly<z.output<typeof DesktopPinVerifyResultSchema>>;
export type DesktopLogoutResult = DeepReadonly<z.output<typeof DesktopLogoutResultSchema>>;
export type DesktopHealthGetResult = DeepReadonly<z.output<typeof DesktopHealthGetResultSchema>>;
export type DesktopPhotoUploadInput = DeepReadonly<z.output<typeof DesktopPhotoUploadInputSchema>>;
export type DesktopPhotoUploadResult = DeepReadonly<
  z.output<typeof DesktopPhotoUploadResultSchema>
>;
export type DesktopPhotoReadInput = DeepReadonly<z.output<typeof DesktopPhotoReadInputSchema>>;
export type DesktopPhotoReadResult = DeepReadonly<z.output<typeof DesktopPhotoReadResultSchema>>;
export type DesktopPhotoDeleteInput = DeepReadonly<z.output<typeof DesktopPhotoDeleteInputSchema>>;
export type DesktopPhotoDeleteResult = DeepReadonly<
  z.output<typeof DesktopPhotoDeleteResultSchema>
>;
export type DesktopSessionView = DeepReadonly<z.output<typeof DesktopSessionViewSchema>>;
export type DesktopStaffDirectoryEntry = DeepReadonly<
  z.output<typeof DesktopStaffDirectoryEntrySchema>
>;
