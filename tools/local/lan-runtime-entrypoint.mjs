import { loadRuntimeLanGatewayConfig } from "./lan-gateway-config.mjs";
import { createLanGateway, loadLanStaticAssets } from "./lan-gateway-core.mjs";
import { listenLanGateway } from "./lan-gateway-lifecycle.mjs";

export const RUNTIME_LAN_PATHS = Object.freeze({
  configPath: "/run/secrets/lan-config",
  certPath: "/run/secrets/lan-cert",
  keyPath: "/run/secrets/lan-key",
  webRoot: "/opt/laundry/owner-spa",
});

export async function startRuntimeLanGateway(dependencies = {}) {
  const loadConfig = dependencies.loadConfig ?? loadRuntimeLanGatewayConfig;
  const loadAssets = dependencies.loadAssets ?? loadLanStaticAssets;
  const createGateway = dependencies.createGateway ?? createLanGateway;
  const listen = dependencies.listen ?? listenLanGateway;
  const onRuntimeError = dependencies.onRuntimeError ?? (() => {});
  const config = await loadConfig(RUNTIME_LAN_PATHS);
  const assets = await loadAssets(config.webRoot, config.ownerSpaSha256);
  const server = createGateway(config, assets);
  await listen(server, {
    port: config.port,
    bindHost: config.listenHost,
    onRuntimeError,
  });
  return Object.freeze({ config, server });
}

export async function runRuntimeLanGateway() {
  let closing = false;
  let server;
  const close = (requestedExitCode) => {
    if (closing || server === undefined) return;
    closing = true;
    server.close((error) => {
      if (error !== undefined) process.stderr.write("LAN gateway shutdown failed\n");
      process.exitCode = error === undefined ? requestedExitCode : 1;
    });
  };
  const onRuntimeError = () => {
    process.stderr.write("LAN gateway runtime error\n");
    close(1);
  };
  const started = await startRuntimeLanGateway({ onRuntimeError });
  server = started.server;
  process.stdout.write(`Laundry Desk Owner Dashboard ready at ${started.config.origin}/owner\n`);
  process.once("SIGINT", () => close(0));
  process.once("SIGTERM", () => close(0));
}
