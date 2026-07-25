/**
 * Local HTTP entry: memory identity (default) or Postgres when DATABASE_URL /
 * LAUNDRY_USE_LOCAL_PG is set.
 *
 *   pnpm local:server
 *   LAUNDRY_USE_LOCAL_PG=1 pnpm local:server
 *
 * Env is parsed by the strict local server configuration boundary.
 */

import { createLocalApp } from "./create-app.js";
import { parseLocalHostConfig } from "../local/config.js";
import { createLocalRuntime } from "../local/create-runtime.js";
import { LOCAL_PROFILE } from "../local/profile.js";

async function main(): Promise<void> {
  const config = parseLocalHostConfig(process.env);
  const runtime = await createLocalRuntime(process.env);
  const app = await createLocalApp({
    runtime,
    corsOrigin: config.browserOrigin,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    if (runtime.pool !== null) {
      await runtime.pool.end();
    }
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await app.listen({ port: config.port, host: config.listenHost });
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
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`local server failed: ${message}\n`);
  process.exitCode = 1;
});
