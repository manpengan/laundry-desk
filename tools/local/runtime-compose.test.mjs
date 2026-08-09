import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composePath = new URL("../compose/docker-compose.runtime.yml", import.meta.url);

test("installed runtime compose is image-only and digest inputs are mandatory", async () => {
  const source = await readFile(composePath, "utf8");

  assert.match(source, /LAUNDRY_RUNTIME_SERVER_IMAGE:\?signed server image digest required/u);
  assert.match(source, /LAUNDRY_RUNTIME_POSTGRES_IMAGE:\?signed PostgreSQL 16 digest required/u);
  assert.doesNotMatch(source, /^\s*(?:build|context):/mu);
  assert.doesNotMatch(source, /\.\.\/|\.\.\\|packages\/|apps\/|tools\//u);
  assert.doesNotMatch(source, /:\/workspace|:\/repo/u);
});

test("installed runtime mounts private files as compose secrets and never secret values", async () => {
  const source = await readFile(composePath, "utf8");

  for (const variable of [
    "DATABASE_URL_FILE",
    "DATABASE_ADMIN_URL_FILE",
    "LAUNDRY_ACCESS_TOKEN_SECRET_FILE",
    "LAUNDRY_CSRF_PROOF_SECRET_FILE",
    "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD_FILE",
    "LAUNDRY_BOOTSTRAP_ADMIN_PIN_FILE",
    "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD_FILE",
    "LAUNDRY_BOOTSTRAP_APPROVER_PIN_FILE",
    "LAUNDRY_COMMISSION_APPROVER_PASSWORD_FILE",
    "LAUNDRY_COMMISSION_APPROVER_PIN_FILE",
  ]) {
    assert.match(source, new RegExp(`${variable}: /run/secrets/`, "u"));
  }
  assert.equal([...source.matchAll(/^\s+mode: 0400$/gmu)].length, 23);
  assert.equal([...source.matchAll(/^\s+uid: "10001"$/gmu)].length, 22);
  assert.equal([...source.matchAll(/^\s+gid: "10001"$/gmu)].length, 22);
  assert.doesNotMatch(
    source,
    /\b(?:DATABASE_URL|DATABASE_ADMIN_URL|POSTGRES_PASSWORD|LAUNDRY_APP_PASSWORD):/u,
  );
  assert.doesNotMatch(source, /LAUNDRY_PG_APP_URL/u);
});

test("stop-safe runtime uses the two controller-bound external persistent volumes", async () => {
  const source = await readFile(composePath, "utf8");

  assert.match(source, /^\s{2}pgdata-v2:$/mu);
  assert.match(
    source,
    /^\s{4}name: "\$\{LAUNDRY_RUNTIME_PGDATA_VOLUME:-laundry-desk-runtime_pgdata-v2\}"$/mu,
  );
  assert.match(source, /^\s{2}photos:$/mu);
  assert.match(
    source,
    /^\s{4}name: "\$\{LAUNDRY_RUNTIME_PHOTOS_VOLUME:-laundry-desk-runtime_photos\}"$/mu,
  );
  assert.equal([...source.matchAll(/^\s{4}external: true$/gmu)].length, 2);
  assert.doesNotMatch(source, /down --volumes|volume rm|external:\s*false/u);
});

test("all Node runtime services use a read-only least-privilege container profile", async () => {
  const source = await readFile(composePath, "utf8");

  assert.match(source, /^x-runtime-security: &runtime-security$/mu);
  assert.match(source, /^\s{2}user: "10001:10001"$/mu);
  assert.match(source, /^\s{2}read_only: true$/mu);
  assert.match(source, /^\s{4}- ALL$/mu);
  assert.match(source, /^\s{4}- no-new-privileges:true$/mu);
  assert.match(
    source,
    /^\s{4}- \/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777,uid=10001,gid=10001$/mu,
  );
  for (const service of ["roles", "migrate", "bootstrap", "commission", "verify", "server"]) {
    assert.match(source, new RegExp(`^  ${service}:\\n    <<: \\*runtime-security$`, "mu"));
  }
});

test("server has one explicit writable volume while its root filesystem remains read-only", async () => {
  const source = await readFile(composePath, "utf8");

  assert.match(source, /^\s{6}- type: volume$/mu);
  assert.match(source, /^\s{8}source: photos$/mu);
  assert.match(source, /^\s{8}target: \/var\/lib\/laundry\/photos$/mu);
  assert.match(source, /^\s{8}read_only: false$/mu);
  assert.match(source, /^\s{10}nocopy: false$/mu);
});
