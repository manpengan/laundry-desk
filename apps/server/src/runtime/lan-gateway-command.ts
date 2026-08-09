export const EMBEDDED_LAN_GATEWAY_URL =
  "file:///opt/laundry/lan-gateway/lan-runtime-entrypoint.mjs";

type ModuleLoader = (specifier: string) => Promise<unknown>;

type LanGatewayCommandDependencies = Readonly<{
  loadModule?: ModuleLoader;
}>;

const loadEmbeddedModule = async (): Promise<unknown> =>
  await import("file:///opt/laundry/lan-gateway/lan-runtime-entrypoint.mjs");

export async function runEmbeddedLanGateway(
  dependencies: LanGatewayCommandDependencies = {},
): Promise<void> {
  const candidate =
    dependencies.loadModule === undefined
      ? await loadEmbeddedModule()
      : await dependencies.loadModule(EMBEDDED_LAN_GATEWAY_URL);
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new Error("RUNTIME_LAN_GATEWAY_MODULE_INVALID");
  }
  const run = (candidate as Record<string, unknown>).runRuntimeLanGateway;
  if (typeof run !== "function") throw new Error("RUNTIME_LAN_GATEWAY_MODULE_INVALID");
  await run();
}
