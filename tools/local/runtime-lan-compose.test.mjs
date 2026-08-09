import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const overlayPath = new URL("../compose/docker-compose.runtime-lan.yml", import.meta.url);

function gatewaySection(source) {
  const section = source.split(/^  lan-gateway:$/mu)[1]?.split(/^secrets:$/mu)[0];
  assert.ok(section);
  return section;
}

test("LAN overlay reuses the signed Server OCI and shares only the server network namespace", async () => {
  const source = await readFile(overlayPath, "utf8");

  assert.match(source, /^\s{2}lan-gateway:$/mu);
  assert.match(
    source,
    /^\s{4}image: "\$\{LAUNDRY_RUNTIME_SERVER_IMAGE:\?signed server image digest required\}"$/mu,
  );
  assert.match(source, /^\s{4}command: \["lan-gateway"\]$/mu);
  assert.match(source, /^\s{4}network_mode: "service:server"$/mu);
  assert.doesNotMatch(gatewaySection(source), /^\s{4}(?:build|ports):/mu);
  assert.doesNotMatch(source, /node_modules|pnpm|\/workspace|\/repo/u);
});

test("LAN overlay publishes one explicit RFC1918 host port while base ports stay unchanged", async () => {
  const source = await readFile(overlayPath, "utf8");

  assert.match(
    source,
    /"\$\{LAUNDRY_RUNTIME_LAN_BIND_HOST:\?explicit RFC1918 bind host required\}:\$\{LAUNDRY_RUNTIME_LAN_PORT:\?explicit LAN port required\}:\$\{LAUNDRY_RUNTIME_LAN_PORT:\?explicit LAN port required\}"/u,
  );
  assert.doesNotMatch(source, /0\.0\.0\.0:|:\b(?:8543|8787):(?:8543|8787)\b/u);
  assert.doesNotMatch(source, /LAUNDRY_RUNTIME_LAN_BIND_HOST:-|LAUNDRY_RUNTIME_LAN_PORT:-/u);
  assert.match(
    source,
    /LAUNDRY_LAN_ORIGIN: "https:\/\/\$\{LAUNDRY_RUNTIME_LAN_BIND_HOST:\?explicit RFC1918 bind host required\}:\$\{LAUNDRY_RUNTIME_LAN_PORT:\?explicit LAN port required\}"/u,
  );
});

test("LAN gateway accepts only fixed file mounts and retains the hardened Node profile", async () => {
  const source = await readFile(overlayPath, "utf8");

  for (const target of ["lan-config", "lan-cert", "lan-key"]) {
    assert.match(source, new RegExp(`target: ${target}$`, "mu"));
    assert.match(source, new RegExp(`^  ${target}:\\n    file:`, "mu"));
  }
  const gatewaySource = gatewaySection(source);
  assert.doesNotMatch(gatewaySource, /LAUNDRY_(?:LAN_ORIGIN|LAN_CONFIG|TLS_CERT|TLS_KEY):/u);
  assert.match(source, /^\s{4}user: "10001:10001"$/mu);
  assert.match(source, /^\s{4}read_only: true$/mu);
  assert.match(source, /^\s{6}- ALL$/mu);
  assert.match(source, /^\s{6}- no-new-privileges:true$/mu);
});

test("LAN gateway readiness uses the embedded strict HTTPS health probe", async () => {
  const source = await readFile(overlayPath, "utf8");
  const gatewaySource = gatewaySection(source);

  assert.match(
    gatewaySource,
    /test: \["CMD", "node", "\/opt\/laundry\/lan-gateway\/lan-runtime-healthcheck\.mjs"\]/u,
  );
  assert.match(gatewaySource, /^\s{6}interval: 2s$/mu);
  assert.match(gatewaySource, /^\s{6}timeout: 3s$/mu);
  assert.match(gatewaySource, /^\s{6}retries: 15$/mu);
  assert.doesNotMatch(gatewaySource, /curl|wget|--insecure|-k(?:\s|$)/u);
});
