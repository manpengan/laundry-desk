import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { createPgPool } from "../db/pg-pool.js";
import { createPasswordPort } from "../identity/password.js";
import {
  BootstrapError,
  BootstrapInputSchema,
  bootstrapLocalIdentity,
  type BootstrapInput,
  type BootstrapResult,
} from "./bootstrap.js";
import { LOCAL_PROFILE } from "./profile.js";
import { resolveSecretEnvironment } from "./secret-file.js";

const LOCAL_CONFIRMATION = "laundry-desk-v2-local";
const DEMO_CONFIRMATION = "laundry-desk-v2-demo";

export type BootstrapCliEnvironment = Readonly<Record<string, string | undefined>>;

export type BootstrapCliOptions = Readonly<{
  argv: readonly string[];
  env: BootstrapCliEnvironment;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}>;

export type BootstrapCliDependencies = Readonly<{
  bootstrap: (databaseAdminUrl: string, input: BootstrapInput) => Promise<BootstrapResult>;
}>;

class CliInputError extends Error {
  readonly code:
    | "ARGS_INVALID"
    | "CONFIRMATION_REQUIRED"
    | "DEMO_DATABASE_NOT_LOOPBACK"
    | "DEMO_DATABASE_QUERY_FORBIDDEN";

  constructor(
    code:
      | "ARGS_INVALID"
      | "CONFIRMATION_REQUIRED"
      | "DEMO_DATABASE_NOT_LOOPBACK"
      | "DEMO_DATABASE_QUERY_FORBIDDEN",
  ) {
    super(code);
    this.name = "CliInputError";
    this.code = code;
  }
}

const validPostgresUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "postgresql:" || url.protocol === "postgres:";
  } catch {
    return false;
  }
};

const EnvironmentSchema = z.object({
  DATABASE_ADMIN_URL: z
    .string()
    .min(1, "is required")
    .refine(validPostgresUrl, "must be a valid PostgreSQL URL"),
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: z.string().min(1, "is required"),
});

const BOOTSTRAP_SECRET_NAMES = Object.freeze([
  "DATABASE_ADMIN_URL",
  "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
  "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
]);

const parseConfirmation = (argv: readonly string[]): string => {
  if (argv.length !== 2 || argv[0] !== "--confirm" || argv[1] === undefined) {
    throw new CliInputError("ARGS_INVALID");
  }
  return argv[1];
};

const isLoopbackHostname = (hostname: string): boolean => {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const ipVersion = isIP(unwrapped);
  if (ipVersion === 4) {
    return unwrapped.split(".")[0] === "127";
  }
  if (ipVersion === 6) {
    return unwrapped.toLowerCase() === "::1";
  }
  return unwrapped.toLowerCase() === "localhost";
};

const assertConfirmation = (
  confirmation: string,
  databaseAdminUrl: string,
  demoOnly: boolean,
): void => {
  const expected = demoOnly ? DEMO_CONFIRMATION : LOCAL_CONFIRMATION;
  if (confirmation !== expected) {
    throw new CliInputError("CONFIRMATION_REQUIRED");
  }
  if (!demoOnly) {
    return;
  }
  const parsedUrl = new URL(databaseAdminUrl);
  if (parsedUrl.search.length > 0) {
    throw new CliInputError("DEMO_DATABASE_QUERY_FORBIDDEN");
  }
  if (!isLoopbackHostname(parsedUrl.hostname)) {
    throw new CliInputError("DEMO_DATABASE_NOT_LOOPBACK");
  }
};

const parseInput = (
  argv: readonly string[],
  environment: BootstrapCliEnvironment,
): Readonly<{ databaseAdminUrl: string; input: BootstrapInput }> => {
  const confirmation = parseConfirmation(argv);
  const env = EnvironmentSchema.parse(
    resolveSecretEnvironment(environment, BOOTSTRAP_SECRET_NAMES),
  );
  const demoOnly = environment.LAUNDRY_LOCAL_DEMO === "1";
  assertConfirmation(confirmation, env.DATABASE_ADMIN_URL, demoOnly);
  const input = BootstrapInputSchema.parse({
    profile: LOCAL_PROFILE,
    adminUsername: env.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME,
    adminDisplayName: env.LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME,
    adminPassword: env.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
    adminPin: env.LAUNDRY_BOOTSTRAP_ADMIN_PIN,
    demoOnly,
  });
  return Object.freeze({ databaseAdminUrl: env.DATABASE_ADMIN_URL, input });
};

const safeZodMessage = (error: z.ZodError): string =>
  error.issues
    .map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`)
    .join("\n");

const successOutput = (result: BootstrapResult): string =>
  `${JSON.stringify({
    status: result.status,
    org_id: result.orgId,
    store_id: result.storeId,
    admin_staff_id: result.adminStaffId,
    demo_only: result.demoOnly,
  })}\n`;

const errorOutput = (error: unknown): string => {
  if (error instanceof z.ZodError) {
    return `${safeZodMessage(error)}\n`;
  }
  if (error instanceof CliInputError || error instanceof BootstrapError) {
    return `${error.code}\n`;
  }
  return "BOOTSTRAP_FAILED\n";
};

export async function runBootstrapCli(
  options: BootstrapCliOptions,
  dependencies: BootstrapCliDependencies,
): Promise<number> {
  try {
    const request = parseInput(options.argv, options.env);
    const result = await dependencies.bootstrap(request.databaseAdminUrl, request.input);
    options.stdout(successOutput(result));
    return 0;
  } catch (error) {
    options.stderr(errorOutput(error));
    return 1;
  }
}

const bootstrapWithDatabase = async (
  databaseAdminUrl: string,
  input: BootstrapInput,
): Promise<BootstrapResult> => {
  const pool = createPgPool({ connectionString: databaseAdminUrl, max: 1 });
  try {
    return await bootstrapLocalIdentity(
      Object.freeze({ pool, passwordPort: createPasswordPort() }),
      input,
    );
  } finally {
    await pool.end();
  }
};

const isMainModule = (): boolean => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runBootstrapCli(
    Object.freeze({
      argv: process.argv.slice(2),
      env: process.env,
      stdout: (text: string): void => {
        process.stdout.write(text);
      },
      stderr: (text: string): void => {
        process.stderr.write(text);
      },
    }),
    Object.freeze({ bootstrap: bootstrapWithDatabase }),
  ).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
