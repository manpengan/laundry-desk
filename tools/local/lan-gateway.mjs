import { loadLanGatewayConfig } from "./lan-gateway-config.mjs";
import { createLanGateway, loadLanStaticAssets } from "./lan-gateway-core.mjs";
import { listenLanGateway } from "./lan-gateway-lifecycle.mjs";

const config = await loadLanGatewayConfig();
const assets = await loadLanStaticAssets(config.webRoot);
const server = createLanGateway(config, assets);

let closing = false;
const close = (requestedExitCode) => {
  if (closing) return;
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

await listenLanGateway(server, {
  port: config.port,
  bindHost: config.bindHost,
  onRuntimeError,
});
process.stdout.write(`Laundry Desk Owner Dashboard ready at ${config.origin}/owner\n`);

process.once("SIGINT", () => close(0));
process.once("SIGTERM", () => close(0));
