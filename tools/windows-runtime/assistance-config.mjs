import { createPublicKey } from "node:crypto";
import { join } from "node:path";
import { digest, exactKeys, fail } from "./companion-contract.mjs";
import { readMaintenance } from "./backup-files.mjs";

export function requireAssistanceOptions(options) {
  if (!exactKeys(options, ["trust"])) fail("ARGS_INVALID");
  const value = options.trust;
  if (value === null) return options;
  if (
    !exactKeys(value, [
      "version",
      "broker_url",
      "broker_token",
      "issuer",
      "audience",
      "kid",
      "public_key_spki",
    ]) ||
    value.version !== 1 ||
    ![value.issuer, value.audience, value.kid].every(
      (v) => typeof v === "string" && /^[\x21-\x7e]{1,256}$/u.test(v),
    ) ||
    typeof value.broker_token !== "string" ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(value.broker_token) ||
    typeof value.public_key_spki !== "string" ||
    !/^[A-Za-z0-9+/]{1,1024}={0,2}$/u.test(value.public_key_spki) ||
    typeof value.broker_url !== "string" ||
    value.broker_url.length > 2048
  )
    fail("ARGS_INVALID");
  try {
    const url = new URL(value.broker_url);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(url.hostname) ||
      !url.hostname.includes(".")
    )
      fail("ARGS_INVALID");
    const key = createPublicKey({
      key: Buffer.from(value.public_key_spki, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") fail("ARGS_INVALID");
  } catch {
    fail("ARGS_INVALID");
  }
  return options;
}

export async function configureAssistance(options, lifecycle) {
  requireAssistanceOptions(options);
  const state = lifecycle.getState();
  if (
    !["running", "stopped", "initialized"].includes(state.phase) ||
    state.pending ||
    (await readMaintenance(lifecycle.io, lifecycle.root))
  )
    fail("MAINTENANCE_RECOVERY_REQUIRED");
  const { manifest } = await lifecycle.verify(state.current);
  if (!manifest.files.some((file) => file.path === "server/dist/remote-assistance/routes.js"))
    fail("ASSISTANCE_UPGRADE_REQUIRED");
  await lifecycle.stop(state.current);
  const path = join(lifecycle.root, "secrets/remote-assistance.json");
  await lifecycle.io.write(path, JSON.stringify(options.trust));
  if ((await lifecycle.io.read(path)) !== JSON.stringify(options.trust))
    fail("ASSISTANCE_CONFIG_CHANGED");
  await lifecycle.io.write(
    join(lifecycle.root, "remote-assistance-config-receipt.json"),
    JSON.stringify({
      version: 1,
      at: new Date().toISOString(),
      enabled: options.trust !== null,
      trust_sha256: options.trust
        ? digest(
            JSON.stringify({
              issuer: options.trust.issuer,
              audience: options.trust.audience,
              kid: options.trust.kid,
              public_key_spki: options.trust.public_key_spki,
              broker_url: options.trust.broker_url,
            }),
          )
        : null,
    }),
  );
  if (state.phase === "running") await lifecycle.start(state.current);
  return {
    status: "assistance_configured",
    enabled: options.trust !== null,
    assurance: "development_only",
  };
}
