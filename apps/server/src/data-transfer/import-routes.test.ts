import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPgPool } from "../db/pg-pool.js";
import { createMemoryLocalRuntime, DEMO_PASSWORD } from "../local/demo-seed.js";
import { createPhotoFileStore } from "../photo/file-store.js";
import { createLocalApp } from "../http/create-app.js";
import { resolveCookiePolicy } from "../http/cookie-policy.js";
import { LOCAL_COOKIE_NAMES } from "../http/types.js";
import type { SecurityEventInput } from "../http/security-events.js";

const browser = {
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
};
const base = "/api/v2/migrations/v1/drafts";
test("migration routes enforce session, admin, CSRF, strict authorization and password limits before persistence", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "laundry-v1-http-")));
  // A real lazy Pool aimed at a closed loopback port: these negative cases must
  // never reach persistence. The full success transaction is covered in PG tests.
  const pool = createPgPool({
    connectionString: "postgresql://laundry_app@127.0.0.1:1/unused",
    connectionTimeoutMillis: 100,
  });
  const memory = await createMemoryLocalRuntime();
  const files = await createPhotoFileStore({ rootPath: join(dir, "photos") });
  const events: SecurityEventInput[] = [];
  const app = await createLocalApp({
    runtime: { ...memory, pool, photo: { ...memory.photo, files } },
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
    securityEventSink: {
      record: (_request, event) => {
        events.push(event);
      },
    },
  });
  async function login(username: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browser,
      payload: {
        org_code: "local",
        store_code: "main",
        username,
        password: DEMO_PASSWORD,
        device_id: randomUUID(),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const raw = response.headers["set-cookie"];
    const pairs = (Array.isArray(raw) ? raw : [raw ?? ""]).map((line) => line.split(";", 1)[0]!);
    const csrf = pairs
      .find((pair) => pair.startsWith(`${LOCAL_COOKIE_NAMES.csrf}=`))
      ?.split("=")[1];
    assert.ok(csrf);
    return {
      ...browser,
      authorization: `Bearer ${(response.json() as { data: { access_token: string } }).data.access_token}`,
      cookie: pairs.join("; "),
      "x-csrf-token": csrf,
    };
  }
  try {
    const unknown = await app.inject({
      method: "POST",
      url: base,
      headers: { ...browser, "content-type": "application/vnd.laundry.v1-migration" },
      payload: Buffer.from("bad"),
    });
    assert.equal(unknown.statusCode, 401);
    const clerk = await login("staff");
    const denied = await app.inject({
      method: "GET",
      url: `${base}/${randomUUID()}/review`,
      headers: clerk,
    });
    assert.equal(denied.statusCode, 403);
    const admin = await login("admin");
    const noCsrf = await app.inject({
      method: "POST",
      url: base,
      headers: {
        ...browser,
        authorization: admin.authorization,
        "content-type": "application/vnd.laundry.v1-migration",
      },
      payload: Buffer.from("bad"),
    });
    assert.equal(noCsrf.statusCode, 403);
    const body = {
      source_sha256: "a".repeat(64),
      plan_sha256: "b".repeat(64),
      photos_sha256: "c".repeat(64),
      photo_associations_reviewed: true,
      password: "synthetic-wrong-password",
    };
    const url = `${base}/${randomUUID()}/authorize`;
    const injected = await app.inject({
      method: "POST",
      url,
      headers: admin,
      payload: { ...body, org_id: randomUUID() },
    });
    assert.equal(injected.statusCode, 400);
    for (let n = 0; n < 5; n += 1) {
      const failed = await app.inject({ method: "POST", url, headers: admin, payload: body });
      assert.equal(failed.statusCode, 401, failed.body);
      assert.equal(failed.body.includes(body.password), false);
    }
    const limited = await app.inject({ method: "POST", url, headers: admin, payload: body });
    assert.equal(limited.statusCode, 429);
    assert.equal(events.filter((event) => event.reason === "LOGIN_FAILED").length, 5);
    assert.equal(events.filter((event) => event.reason === "LOGIN_RATE_LIMITED").length, 1);
    assert.deepEqual(
      (await readdir(join(dir, "import-requests"))).filter((name) => !name.startsWith(".")),
      [],
    );
  } finally {
    await app.close();
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
