import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfileUrl = new URL("../../apps/server/Dockerfile.runtime", import.meta.url);
const developmentDockerfileUrl = new URL("../../apps/server/Dockerfile", import.meta.url);

test("server images build the file-linked platform filesystem package first", async () => {
  for (const [name, url] of [
    ["development", developmentDockerfileUrl],
    ["runtime", dockerfileUrl],
  ]) {
    const source = await readFile(url, "utf8");
    assert.match(
      source,
      /COPY packages\/platform-fs\/package\.json packages\/platform-fs\/package\.json/u,
      `${name} image must install the platform package manifest`,
    );
    assert.match(
      source,
      /--filter @laundry\/platform-fs\.\.\./u,
      `${name} image must install the file-linked platform package`,
    );
    assert.match(
      source,
      /COPY packages\/platform-fs packages\/platform-fs/u,
      `${name} image must copy the platform package sources`,
    );

    const platformBuild = source.indexOf("pnpm --filter @laundry/platform-fs build");
    const serverBuild = source.indexOf("pnpm --filter @laundry/server... build");
    assert.ok(platformBuild >= 0, `${name} image must build the platform package`);
    assert.ok(serverBuild > platformBuild, `${name} image must build Server after platform-fs`);
  }
});

test("runtime server image contains a fixed compiled entrypoint and migration resources", async () => {
  const source = await readFile(dockerfileUrl, "utf8");

  assert.match(
    source,
    /ENTRYPOINT \["node", "\/opt\/laundry\/server\/dist\/runtime\/kit-entrypoint\.js"\]/u,
  );
  assert.match(
    source,
    /COPY --chown=10001:10001 packages\/db\/src\/migrations \/opt\/laundry\/migrations/u,
  );
  assert.match(source, /pnpm --filter @laundry\/server deploy --legacy --prod \/runtime\/server/u);
  assert.doesNotMatch(source.split("FROM node:22-bookworm-slim AS runtime")[1], /corepack|pnpm/u);
});

test("runtime server image builds and embeds the Owner SPA with the fixed LAN gateway modules", async () => {
  const source = await readFile(dockerfileUrl, "utf8");

  assert.match(source, /COPY apps\/web apps\/web/u);
  assert.match(source, /COPY packages\/ui packages\/ui/u);
  assert.match(source, /pnpm --filter @laundry\/web build/u);
  assert.match(
    source,
    /COPY --chown=10001:10001 --from=build \/workspace\/apps\/web\/dist-spa \/opt\/laundry\/owner-spa/u,
  );
  assert.match(
    source,
    /COPY --chown=10001:10001 --from=build \/workspace\/tools\/local\/lan-gateway-/u,
  );
  assert.match(
    source,
    /COPY --chown=10001:10001 --from=build \/workspace\/tools\/local\/lan-runtime-healthcheck\.mjs \/opt\/laundry\/lan-gateway\/lan-runtime-healthcheck\.mjs/u,
  );
  assert.doesNotMatch(
    source.split("FROM node:22-bookworm-slim AS runtime")[1],
    /apps\/web\/src|packages\/ui\/src/u,
  );
});

test("runtime image fixes the Node process identity and seeds its only durable write path", async () => {
  const source = await readFile(dockerfileUrl, "utf8");
  const runtime = source.split("FROM node:22-bookworm-slim AS runtime")[1];

  assert.match(runtime, /groupadd --gid 10001 laundry/u);
  assert.match(runtime, /useradd --uid 10001 --gid 10001/u);
  assert.match(runtime, /COPY --chown=10001:10001 --from=build/u);
  assert.match(
    runtime,
    /COPY --chown=10001:10001 packages\/db\/src\/migrations \/opt\/laundry\/migrations/u,
  );
  assert.match(runtime, /install -d --owner=10001 --group=10001 --mode=0700/u);
  assert.match(runtime, /> \/var\/lib\/laundry\/photos\/\.laundry-photo-store-v1/u);
  assert.match(runtime, /^USER 10001:10001$/mu);
  assert.doesNotMatch(runtime, /^USER (?:0|root)(?::(?:0|root))?$/mu);
});

test("runtime image labels bind every signed release artifact gate", async () => {
  const source = await readFile(dockerfileUrl, "utf8");
  for (const label of [
    "release",
    "contracts-major",
    "contracts-sha256",
    "server-version",
    "web-bundle-sha256",
    "schema-sha256",
    "migrations-sha256",
    "migration-head",
  ]) {
    assert.match(source, new RegExp(`com\\.laundry-desk\\.runtime\\.${label}=`, "u"));
  }
});
