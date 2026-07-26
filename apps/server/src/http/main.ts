/**
 * Local HTTP entry: PostgreSQL through an explicit laundry_app DATABASE_URL.
 *
 *   pnpm local:server
 *   pnpm local:up
 *
 * Env is parsed by the strict local server configuration boundary.
 */

import { safeErrorContext } from "./local-logger.js";
import { startLocalHttpServer } from "./server-lifecycle.js";
import { LOCAL_PROFILE } from "../local/profile.js";

async function main(): Promise<void> {
  const { runtime, config, shutdown } = await startLocalHttpServer(process.env);
  const exitAfterShutdown = (): void => {
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.once("SIGINT", exitAfterShutdown);
  process.once("SIGTERM", exitAfterShutdown);

  process.stdout.write(
    [
      `${LOCAL_PROFILE.orgName} local server listening on http://${config.listenHost}:${config.port}`,
      `  mode ${runtime.mode}`,
      `  GET  /health`,
      `  POST /api/v2/auth/login`,
      `  POST /api/v2/auth/pin/*`,
      `  POST /v1/commands/:name`,
      `  GET  /api/v2/local/staff`,
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  const context = safeErrorContext(error);
  process.stderr.write(`local server failed: ${context.error_type}\n`);
  process.exitCode = 1;
});
