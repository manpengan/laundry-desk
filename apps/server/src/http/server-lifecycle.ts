import type { FastifyInstance } from "fastify";

import type { LocalRuntime } from "../local/demo-seed.js";
import { parseLocalHostConfig, type LocalHostConfig } from "../local/config.js";
import { createLocalApp, type CreateAppOptions } from "./create-app.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createHttpRuntime } from "./http-runtime.js";
import { safeErrorContext } from "./local-logger.js";

export type LocalHttpApp = Pick<FastifyInstance, "listen" | "close">;

export type ResourceCleanupFailure = Readonly<{
  resource: "http" | "print_worker" | "database";
  error_type: string;
}>;

export type StartLocalHttpDependencies = Readonly<{
  createRuntime: (env: NodeJS.ProcessEnv) => Promise<LocalRuntime>;
  createApp: (options: CreateAppOptions) => Promise<LocalHttpApp>;
  reportCleanupFailures: (failures: readonly ResourceCleanupFailure[]) => void;
}>;

export type StartedLocalHttpServer = Readonly<{
  app: LocalHttpApp;
  runtime: LocalRuntime;
  config: LocalHostConfig;
  shutdown: () => Promise<void>;
}>;

const DEFAULT_DEPENDENCIES: StartLocalHttpDependencies = Object.freeze({
  createRuntime: createHttpRuntime,
  createApp: createLocalApp,
  reportCleanupFailures: (failures) => {
    for (const failure of failures) {
      process.stderr.write(`local ${failure.resource} cleanup failed: ${failure.error_type}\n`);
    }
  },
});

type InternalCleanupFailure = Readonly<{
  report: ResourceCleanupFailure;
  cause: unknown;
}>;

async function closeResources(
  app: LocalHttpApp | null,
  runtime: LocalRuntime | null,
): Promise<readonly InternalCleanupFailure[]> {
  let failures: readonly InternalCleanupFailure[] = Object.freeze([]);
  if (app !== null) {
    try {
      await app.close();
    } catch (error) {
      failures = Object.freeze([
        ...failures,
        Object.freeze({
          report: Object.freeze({
            resource: "http" as const,
            error_type: safeErrorContext(error).error_type,
          }),
          cause: error,
        }),
      ]);
    }
  }
  if (runtime?.print.worker !== undefined) {
    try {
      await runtime.print.worker.stop();
    } catch (error) {
      failures = Object.freeze([
        ...failures,
        Object.freeze({
          report: Object.freeze({
            resource: "print_worker" as const,
            error_type: safeErrorContext(error).error_type,
          }),
          cause: error,
        }),
      ]);
    }
  }
  if (runtime?.pool !== null && runtime?.pool !== undefined) {
    try {
      await runtime.pool.end();
    } catch (error) {
      failures = Object.freeze([
        ...failures,
        Object.freeze({
          report: Object.freeze({
            resource: "database" as const,
            error_type: safeErrorContext(error).error_type,
          }),
          cause: error,
        }),
      ]);
    }
  }
  return failures;
}

function throwCleanupFailures(failures: readonly InternalCleanupFailure[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0]?.cause;
  throw new AggregateError(
    failures.map((failure) => failure.cause),
    "local resource cleanup failed",
  );
}

function reportStartupCleanupFailures(
  dependencies: StartLocalHttpDependencies,
  failures: readonly InternalCleanupFailure[],
): void {
  const reports = Object.freeze(failures.map((failure) => failure.report));
  try {
    dependencies.reportCleanupFailures(reports);
  } catch (error) {
    process.stderr.write(`local cleanup reporter failed: ${safeErrorContext(error).error_type}\n`);
  }
}

function createShutdown(app: LocalHttpApp, runtime: LocalRuntime): () => Promise<void> {
  let shutdown: Promise<void> | null = null;
  return (): Promise<void> => {
    shutdown ??= closeResources(app, runtime).then(throwCleanupFailures);
    return shutdown;
  };
}

export async function startLocalHttpServer(
  env: NodeJS.ProcessEnv,
  dependencies: StartLocalHttpDependencies = DEFAULT_DEPENDENCIES,
): Promise<StartedLocalHttpServer> {
  const config = parseLocalHostConfig(env);
  let runtime: LocalRuntime | null = null;
  let app: LocalHttpApp | null = null;
  try {
    runtime = await dependencies.createRuntime(env);
    app = await dependencies.createApp({
      runtime,
      cookiePolicy: resolveCookiePolicy({ secure: config.cookieSecure }),
      hostAuthorities: config.hostAuthorities,
      browserOrigin: config.browserOrigin,
      browserFetchSite: config.browserFetchSite,
    });
    await app.listen({ port: config.port, host: config.listenHost });
    runtime.print.worker?.start();
    return Object.freeze({
      app,
      runtime,
      config,
      shutdown: createShutdown(app, runtime),
    });
  } catch (error) {
    const cleanupFailures = await closeResources(app, runtime);
    if (cleanupFailures.length > 0) {
      reportStartupCleanupFailures(dependencies, cleanupFailures);
    }
    throw error;
  }
}
