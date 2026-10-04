import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadPlatform } from "./lifecycle-storage.mjs";
import { inspectCompanion } from "./inspect-companion.mjs";

/** Construct actual routes against the shadow without listening or starting workers. */
export async function probeApplication(modules, environment) {
  const runtime = await modules.createRuntime(environment);
  let app;
  try {
    const config = modules.parseConfig(environment);
    app = await modules.createApp({
      runtime,
      cookiePolicy: modules.cookiePolicy({ secure: config.cookieSecure }),
      hostAuthorities: config.hostAuthorities,
      browserOrigin: config.browserOrigin,
      browserFetchSite: config.browserFetchSite,
      trustedProxyClientIpRequired: config.trustedProxyClientIpRequired,
      ...(await modules.aiOptions({
        platform: process.platform,
        mode: runtime.mode,
        listenHost: config.listenHost,
      })),
    });
    await app.ready();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { host: "127.0.0.1:8787" },
    });
    if (response.statusCode !== 200 || response.json()?.data?.status !== "ready")
      throw new Error("WINDOWS_COMPANION_PROGRAM_PROBE_FAILED");
  } finally {
    const cleanups = [];
    if (app) cleanups.push(() => app.close());
    for (const worker of [
      runtime.print?.worker,
      runtime.notification?.worker,
      runtime.automation?.worker,
    ])
      if (worker) cleanups.push(() => worker.stop());
    if (runtime.pool) cleanups.push(() => runtime.pool.end());
    const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    if (results.some((result) => result.status === "rejected"))
      throw new Error("WINDOWS_COMPANION_PROGRAM_PROBE_CLEANUP_FAILED");
  }
}
async function main(payload, expectedDigest) {
  if (!payload || resolve(payload) !== payload)
    throw new Error("WINDOWS_COMPANION_PROGRAM_PROBE_FAILED");
  const manifest = await inspectCompanion(payload, expectedDigest);
  await loadPlatform(payload);
  const module = (path) => import(pathToFileURL(join(payload, "server/dist", path)).href);
  const [runtime, app, config, cookie, ai] = await Promise.all([
    module("http/http-runtime.js"),
    module("http/create-app.js"),
    module("local/config.js"),
    module("http/cookie-policy.js"),
    manifest.files.some((file) => file.path === "server/dist/ai/windows-ai-runtime.js")
      ? module("ai/windows-ai-runtime.js")
      : { windowsAiRuntimeOptions: async () => ({}) },
  ]);
  await probeApplication(
    {
      createRuntime: runtime.createHttpRuntime,
      createApp: app.createLocalApp,
      parseConfig: config.parseLocalHostConfig,
      cookiePolicy: cookie.resolveCookiePolicy,
      aiOptions: ai.windowsAiRuntimeOptions,
    },
    process.env,
  );
  process.stdout.write("WINDOWS_RUNTIME_SHADOW_PROBE_OK\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main(process.argv[2], process.argv[3]).catch(() => {
    process.stderr.write("WINDOWS_COMPANION_PROGRAM_PROBE_FAILED\n");
    process.exitCode = 1;
  });
