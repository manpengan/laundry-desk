/**
 * Local HTTP entry: memory identity (default) or Postgres when DATABASE_URL /
 * LAUNDRY_USE_LOCAL_PG is set.
 *
 *   pnpm local:server
 *   LAUNDRY_USE_LOCAL_PG=1 pnpm local:server
 *
 * Env:
 *   PORT (default 8787)
 *   HOST (default 127.0.0.1)
 *   CORS_ORIGIN (comma-separated, optional)
 *   DATABASE_URL | DATABASE_ADMIN_URL | LAUNDRY_USE_LOCAL_PG=1
 */

import { createLocalApp } from "./create-app.js";
import { createLocalRuntime, DEMO_PASSWORD, DEMO_PIN } from "../local/demo-seed.js";

const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";
const corsOrigin = process.env.CORS_ORIGIN?.split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function main(): Promise<void> {
  const runtime = await createLocalRuntime();
  const app = await createLocalApp({
    runtime,
    ...(corsOrigin !== undefined && corsOrigin.length > 0 ? { corsOrigin } : {}),
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

  await app.listen({ port, host });
  process.stdout.write(
    [
      `laundry local server listening on http://${host}:${port}`,
      `  mode ${runtime.mode}`,
      `  GET  /health`,
      `  POST /api/v2/auth/login  (org_code=hongfa store_code=main username=admin password=${DEMO_PASSWORD})`,
      `  POST /api/v2/auth/pin/*  (PIN ${DEMO_PIN})`,
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
