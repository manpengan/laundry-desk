import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfileUrl = new URL("../../apps/server/Dockerfile.runtime", import.meta.url);

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
