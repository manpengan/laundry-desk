import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { createPgPool } from "../db/pg-pool.js";
import { createPasswordPort } from "../identity/password.js";
import {
  BootstrapError,
  BootstrapInputSchema,
  CommissionInputSchema,
  bootstrapLocalIdentity,
  commissionLocalIdentity,
  type BootstrapInput,
  type BootstrapResult,
  type CommissionInput,
  type CommissionResult,
} from "./bootstrap.js";
import { LOCAL_PROFILE } from "./profile.js";
import { resolveSecretEnvironment } from "./secret-file.js";

const LOCAL_CONFIRMATION = "laundry-desk-v2-local";
const DEMO_CONFIRMATION = "laundry-desk-v2-demo";
const COMMISSION_CONFIRMATION = "laundry-desk-v2-commission";

export type BootstrapCliEnvironment = Readonly<Record<string, string | undefined>>;

export type BootstrapCliOptions = Readonly<{
  argv: readonly string[];
  env: BootstrapCliEnvironment;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}>;

export type BootstrapCliDependencies = Readonly<{
  bootstrap: (databaseAdminUrl: string, input: BootstrapInput) => Promise<BootstrapResult>;
  commission?: (databaseAdminUrl: string, input: CommissionInput) => Promise<CommissionResult>;
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

const DatabaseEnvironmentSchema = z.object({
  DATABASE_ADMIN_URL: z
    .string()
    .min(1, "is required")
    .refine(validPostgresUrl, "must be a valid PostgreSQL URL"),
});

const BootstrapEnvironmentSchema = DatabaseEnvironmentSchema.extend({
  LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_ADMIN_PIN: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_APPROVER_USERNAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: z.string().min(1, "is required"),
  LAUNDRY_BOOTSTRAP_APPROVER_PIN: z.string().min(1, "is required"),
});

const CommissionEnvironmentSchema = DatabaseEnvironmentSchema.extend({
  LAUNDRY_COMMISSION_APPROVER_USERNAME: z.string().min(1, "is required"),
  LAUNDRY_COMMISSION_APPROVER_DISPLAY_NAME: z.string().min(1, "is required"),
  LAUNDRY_COMMISSION_APPROVER_PASSWORD: z.string().min(1, "is required"),
  LAUNDRY_COMMISSION_APPROVER_PIN: z.string().min(1, "is required"),
});

const BOOTSTRAP_SECRET_NAMES = Object.freeze([
  "DATABASE_ADMIN_URL",
  "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
  "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
  "LAUNDRY_BOOTSTRAP_APPROVER_USERNAME",
  "LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME",
  "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD",
  "LAUNDRY_BOOTSTRAP_APPROVER_PIN",
]);

const COMMISSION_SECRET_NAMES = Object.freeze([
  "DATABASE_ADMIN_URL",
  "LAUNDRY_COMMISSION_APPROVER_USERNAME",
  "LAUNDRY_COMMISSION_APPROVER_DISPLAY_NAME",
  "LAUNDRY_COMMISSION_APPROVER_PASSWORD",
  "LAUNDRY_COMMISSION_APPROVER_PIN",
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

const parseBootstrapInput = (
  argv: readonly string[],
  environment: BootstrapCliEnvironment,
): Readonly<{ databaseAdminUrl: string; input: BootstrapInput }> => {
  const confirmation = parseConfirmation(argv);
  const env = BootstrapEnvironmentSchema.parse(
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
    approverUsername: env.LAUNDRY_BOOTSTRAP_APPROVER_USERNAME,
    approverDisplayName: env.LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME,
    approverPassword: env.LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD,
    approverPin: env.LAUNDRY_BOOTSTRAP_APPROVER_PIN,
    demoOnly,
  });
  return Object.freeze({ databaseAdminUrl: env.DATABASE_ADMIN_URL, input });
};

const parseCommissionInput = (
  argv: readonly string[],
  environment: BootstrapCliEnvironment,
): Readonly<{ databaseAdminUrl: string; input: CommissionInput }> => {
  if (
    argv.length !== 3 ||
    argv[0] !== "commission" ||
    argv[1] !== "--confirm" ||
    argv[2] !== COMMISSION_CONFIRMATION
  ) {
    throw new CliInputError(argv[0] === "commission" ? "CONFIRMATION_REQUIRED" : "ARGS_INVALID");
  }
  const env = CommissionEnvironmentSchema.parse(
    resolveSecretEnvironment(environment, COMMISSION_SECRET_NAMES),
  );
  const input = CommissionInputSchema.parse({
    profile: LOCAL_PROFILE,
    approverUsername: env.LAUNDRY_COMMISSION_APPROVER_USERNAME,
    approverDisplayName: env.LAUNDRY_COMMISSION_APPROVER_DISPLAY_NAME,
    approverPassword: env.LAUNDRY_COMMISSION_APPROVER_PASSWORD,
    approverPin: env.LAUNDRY_COMMISSION_APPROVER_PIN,
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
    approver_staff_id: result.approverStaffId,
    demo_only: result.demoOnly,
  })}\n`;

const commissionOutput = (result: CommissionResult): string =>
  `${JSON.stringify({
    status: result.status,
    org_id: result.orgId,
    store_id: result.storeId,
    admin_staff_id: result.adminStaffId,
    approver_staff_id: result.approverStaffId,
    feature_profile_version: result.featureProfileVersion,
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
    if (options.argv[0] === "commission") {
      const request = parseCommissionInput(options.argv, options.env);
      if (dependencies.commission === undefined) throw new CliInputError("ARGS_INVALID");
      const result = await dependencies.commission(request.databaseAdminUrl, request.input);
      options.stdout(commissionOutput(result));
    } else {
      const request = parseBootstrapInput(options.argv, options.env);
      const result = await dependencies.bootstrap(request.databaseAdminUrl, request.input);
      options.stdout(successOutput(result));
    }
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

const commissionWithDatabase = async (
  databaseAdminUrl: string,
  input: CommissionInput,
): Promise<CommissionResult> => {
  const pool = createPgPool({ connectionString: databaseAdminUrl, max: 1 });
  try {
    return await commissionLocalIdentity(
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
    Object.freeze({ bootstrap: bootstrapWithDatabase, commission: commissionWithDatabase }),
  ).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
