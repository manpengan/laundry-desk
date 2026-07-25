import { z } from "zod";

const MINIMUM_SECRET_BYTES = 32;
const LOCAL_PORT = 8787 as const;
const LOCAL_BROWSER_ORIGIN = "http://127.0.0.1:5173" as const;
const LOCAL_HOST_AUTHORITIES = Object.freeze(["127.0.0.1:8787"] as const);

const SecretSchema = z
  .string()
  .refine(
    (value) => Buffer.byteLength(value, "utf8") >= MINIMUM_SECRET_BYTES,
    `must contain at least ${MINIMUM_SECRET_BYTES} UTF-8 bytes`,
  );

const ContainerRuntimeSchema = z
  .string()
  .refine((value) => value === "1", "must equal 1 when set")
  .optional();

const LocalHostEnvironmentSchema = z.object({
  LAUNDRY_CONTAINER_RUNTIME: ContainerRuntimeSchema,
});

const LocalSigningEnvironmentSchema = z
  .object({
    LAUNDRY_ACCESS_TOKEN_SECRET: SecretSchema,
    LAUNDRY_CSRF_PROOF_SECRET: SecretSchema,
  })
  .superRefine((value, context) => {
    if (value.LAUNDRY_ACCESS_TOKEN_SECRET === value.LAUNDRY_CSRF_PROOF_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["LAUNDRY_CSRF_PROOF_SECRET"],
        message: "access and CSRF secrets must be independent",
      });
    }
  });

export type LocalHostConfig = Readonly<{
  listenHost: "127.0.0.1" | "0.0.0.0";
  port: typeof LOCAL_PORT;
  browserOrigin: typeof LOCAL_BROWSER_ORIGIN;
  hostAuthorities: readonly ["127.0.0.1:8787"];
}>;

export type LocalSigningSecrets = Readonly<{
  accessTokenSecret: string;
  csrfProofSecret: string;
}>;

export type LocalServerConfig = Readonly<LocalHostConfig & LocalSigningSecrets>;

function configError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => {
      const field = issue.path[0];
      return `${typeof field === "string" ? field : "environment"}: ${issue.message}`;
    })
    .join("; ");
  return new Error(`Invalid local server configuration: ${details}`);
}

export function parseLocalHostConfig(env: NodeJS.ProcessEnv): LocalHostConfig {
  const result = LocalHostEnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw configError(result.error);
  }

  return Object.freeze({
    listenHost: result.data.LAUNDRY_CONTAINER_RUNTIME === "1" ? "0.0.0.0" : "127.0.0.1",
    port: LOCAL_PORT,
    browserOrigin: LOCAL_BROWSER_ORIGIN,
    hostAuthorities: LOCAL_HOST_AUTHORITIES,
  });
}

export function parseLocalSigningSecrets(env: NodeJS.ProcessEnv): LocalSigningSecrets {
  const result = LocalSigningEnvironmentSchema.safeParse(env);
  if (!result.success) {
    throw configError(result.error);
  }

  return Object.freeze({
    accessTokenSecret: result.data.LAUNDRY_ACCESS_TOKEN_SECRET,
    csrfProofSecret: result.data.LAUNDRY_CSRF_PROOF_SECRET,
  });
}

export function parseLocalServerConfig(env: NodeJS.ProcessEnv): LocalServerConfig {
  return Object.freeze({
    ...parseLocalHostConfig(env),
    ...parseLocalSigningSecrets(env),
  });
}
