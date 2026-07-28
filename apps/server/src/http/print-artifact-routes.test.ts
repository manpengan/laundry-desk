/**
 * Artifact download route — Fastify inject, no listen and no Postgres.
 *
 * Covers the properties that make serving a spooled file safe: authentication,
 * addressing by job id only, refusing a stored name that could walk out of the
 * spool, refusing bytes that no longer match the recorded hash, and marking the
 * response non-sniffable and non-cacheable.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { createFileSpool } from "../print/file-spool.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLocalApp } from "./create-app.js";
type FindArtifact = () => Promise<Readonly<{ path: string; sha256: string; bytes: number }> | null>;

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const localCookies = resolveCookiePolicy({ secure: false });
const hostHeaders = Object.freeze({ host: "127.0.0.1:8787" });
const browserHeaders = Object.freeze({
  ...hostHeaders,
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function buildApp(findArtifact: FindArtifact = async () => null) {
  const base = await mkdtemp(join(tmpdir(), "laundry-artifact-"));
  dirs.push(base);
  const spool = await createFileSpool({ rootPath: join(base, "spool") });
  const runtime = await createMemoryLocalRuntime();
  // The memory print store has no findArtifact, so inject one to mount the route.
  const patched = {
    ...runtime,
    print: { ...runtime.print, store: { ...runtime.print.store, findArtifact } },
  } as typeof runtime;
  const app = await createLocalApp({
    runtime: patched,
    cookiePolicy: localCookies,
    logger: false,
    printSpool: spool,
  });
  return { app, spool };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>["app"]): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: DEVICE,
    },
  });
  assert.equal(response.statusCode, 200);
  return (response.json() as { data: { access_token: string } }).data.access_token;
}

test("requires authentication before serving any artifact", async () => {
  const { app } = await buildApp();
  const response = await app.inject({
    method: "GET",
    url: `/api/v2/print/artifacts/${JOB}`,
    headers: hostHeaders,
  });
  assert.equal(response.statusCode, 401);
  await app.close();
});

test("rejects a job id that is not a uuid instead of touching the filesystem", async () => {
  const { app } = await buildApp();
  const token = await login(app);
  const response = await app.inject({
    method: "GET",
    url: "/api/v2/print/artifacts/..%2F..%2Fetc%2Fpasswd",
    headers: { ...hostHeaders, authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 400);
  await app.close();
});

test("returns 404 when the job has no recorded artifact", async () => {
  const { app } = await buildApp();
  const token = await login(app);
  const response = await app.inject({
    method: "GET",
    url: `/api/v2/print/artifacts/${JOB}`,
    headers: { ...hostHeaders, authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("does not mount the route when no spool is configured", async () => {
  const runtime = await createMemoryLocalRuntime();
  const app = await createLocalApp({ runtime, cookiePolicy: localCookies, logger: false });
  const response = await app.inject({
    method: "GET",
    url: `/api/v2/print/artifacts/${JOB}`,
    headers: hostHeaders,
  });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test("a symlink placed in the spool is never served through", async () => {
  const base = await mkdtemp(join(tmpdir(), "laundry-artifact-link-"));
  dirs.push(base);
  const secret = join(base, "secret.txt");
  await writeFile(secret, "top secret\n", { mode: 0o600 });
  const spool = await createFileSpool({ rootPath: join(base, "spool") });
  const name = `${JOB}-xp58-0001.txt`;
  await symlink(secret, join(spool.rootPath, name));

  const runtime = await createMemoryLocalRuntime();
  const patched = {
    ...runtime,
    print: {
      ...runtime.print,
      store: {
        ...runtime.print.store,
        findArtifact: async () => ({ path: name, sha256: "b".repeat(64), bytes: 11 }),
      },
    },
  } as typeof runtime;
  const app = await createLocalApp({
    runtime: patched,
    cookiePolicy: localCookies,
    logger: false,
    printSpool: spool,
  });
  const token = await login(app);

  const response = await app.inject({
    method: "GET",
    url: `/api/v2/print/artifacts/${JOB}`,
    headers: { ...hostHeaders, authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 404, "a symlinked artifact must not be served");
  assert.doesNotMatch(response.body, /top secret/u);
  await app.close();
});

test("serves a matching artifact as non-sniffable, non-cacheable text", async () => {
  const base = await mkdtemp(join(tmpdir(), "laundry-artifact-ok-"));
  dirs.push(base);
  const spool = await createFileSpool({ rootPath: join(base, "spool") });
  const written = await spool.write({
    job_id: JOB,
    kind: "xp58",
    seq: 1,
    content: "=== MOCK ===\nticket: T-9\n",
  });

  const runtime = await createMemoryLocalRuntime();
  const patched = {
    ...runtime,
    print: {
      ...runtime.print,
      store: {
        ...runtime.print.store,
        findArtifact: async () => ({
          path: written.relative_path,
          sha256: written.sha256,
          bytes: written.bytes,
        }),
      },
    },
  } as typeof runtime;
  const app = await createLocalApp({
    runtime: patched,
    cookiePolicy: localCookies,
    logger: false,
    printSpool: spool,
  });
  const token = await login(app);

  const response = await app.inject({
    method: "GET",
    url: `/api/v2/print/artifacts/${JOB}`,
    headers: { ...hostHeaders, authorization: `Bearer ${token}` },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /ticket: T-9/u);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(String(response.headers["content-type"]), /text\/plain/u);
  await app.close();
});

test("refuses bytes that no longer match the recorded hash", async () => {
  const base = await mkdtemp(join(tmpdir(), "laundry-artifact-tamper-"));
  dirs.push(base);
  const spool = await createFileSpool({ rootPath: join(base, "spool") });
  const written = await spool.write({
    job_id: JOB,
    kind: "xp58",
    seq: 1,
    content: "original\n",
  });

  const runtime = await createMemoryLocalRuntime();
  const patched = {
    ...runtime,
    print: {
      ...runtime.print,
      store: {
        ...runtime.print.store,
        // Hash of something else entirely: the spool no longer matches the record.
        findArtifact: async () => ({
          path: written.relative_path,
          sha256: "c".repeat(64),
          bytes: written.bytes,
        }),
      },
    },
  } as typeof runtime;
  const app = await createLocalApp({
    runtime: patched,
    cookiePolicy: localCookies,
    logger: false,
    printSpool: spool,
  });
  const token = await login(app);

  const response = await app.inject({
    method: "GET",
    url: `/api/v2/print/artifacts/${JOB}`,
    headers: { ...hostHeaders, authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 409, "unverifiable bytes must not be served");
  assert.doesNotMatch(response.body, /original/u);
  await app.close();
});
