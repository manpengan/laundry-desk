import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";
import sharp from "sharp";

import { createIsolatedPgTestDatabase } from "../db/isolated-pg-test-database.js";
import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { createMemoryLocalRuntime, createPgLocalRuntime } from "../local/create-runtime.js";
import { parseLocalServerConfig } from "../local/config.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createPhotoFileStore } from "../photo/file-store.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLocalApp } from "./create-app.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const urls = resolvePgUrls();

test(
  "real PG HTTP photo retries preserve committed bytes and recover an audit rollback",
  { skip: urls === null },
  async (t) => {
    assert.ok(urls);
    const database = await createIsolatedPgTestDatabase(urls);
    const admin = createPgPool({ connectionString: database.urls.admin });
    const pool = createPgPool({ connectionString: database.urls.app });
    const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-pg-photo-http-")));
    const files = await createPhotoFileStore({ rootPath: join(root, "photos") });
    // Close the app and both pools before dropping this test's isolated database.
    let closeApp = async (): Promise<void> => {};
    t.after(async () => {
      const failures: unknown[] = [];
      for (const cleanup of [
        closeApp,
        () => pool.end(),
        () => admin.end(),
        database.close,
        () => rm(root, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Photo PG cleanup failed");
    });
    const memory = await createMemoryLocalRuntime();
    const password = "synthetic-photo-admin-password";
    const { orgId, storeId, adminStaffId: staffId } = LOCAL_PROFILE;
    const orderId = randomUUID();
    const lineId = randomUUID();
    const garmentId = randomUUID();
    await admin.query(
      `INSERT INTO orgs(id,code,name,created_at,updated_at)
     VALUES($1,'local','Photo fixture',now(),now())`,
      [orgId],
    );
    await admin.query(
      `INSERT INTO stores(id,org_id,code,name,timezone,created_at,updated_at)
     VALUES($1,$2,'main','Photo fixture','Asia/Taipei',now(),now())`,
      [storeId, orgId],
    );
    await admin.query(
      `INSERT INTO staffs(id,org_id,username,password_hash,display_name,created_at,updated_at)
     VALUES($1,$2,'fixture',$3,'Photo fixture',now(),now())`,
      [staffId, orgId, await memory.identity.login.passwordPort.hashPassword(password)],
    );
    await admin.query(
      `INSERT INTO staff_store_roles(id,org_id,store_id,staff_id,role,is_privacy_admin,created_at,updated_at)
     VALUES($1,$2,$3,$4,'admin',true,now(),now())`,
      [randomUUID(), orgId, storeId, staffId],
    );
    await admin.query(
      `INSERT INTO store_features(id,org_id,store_id,updated_at) VALUES($1,$2,$3,now())`,
      [randomUUID(), orgId, storeId],
    );
    await admin.query(
      `INSERT INTO orders (
       id,org_id,store_id,ticket_no,status,subtotal_cents,payable_cents,paid_cents,balance_cents,
       created_at,updated_at,created_by_staff_id,business_date
     ) VALUES($1,$2,$3,$4,'open',1000,1000,0,1000,now(),now(),$5,
       to_char(now() AT TIME ZONE 'Asia/Taipei','YYYY-MM-DD'))`,
      [orderId, orgId, storeId, `photo-${orderId}`, staffId],
    );
    await admin.query(
      `INSERT INTO order_lines (
       id,org_id,store_id,order_id,line_index,service_code,category_code,unit_price_cents,qty,line_total_cents
     ) VALUES($1,$2,$3,$4,0,'wash','shirt',1000,1,1000)`,
      [lineId, orgId, storeId, orderId],
    );
    await admin.query(
      `INSERT INTO garments (
       id,org_id,store_id,order_id,order_line_id,seq,barcode,service_code,category_code,unit_price_cents,status
     ) VALUES($1,$2,$3,$4,$5,1,$6,'wash','shirt',1000,'received')`,
      [garmentId, orgId, storeId, orderId, lineId, randomUUID().replaceAll("-", "")],
    );
    const local = await createPgLocalRuntime(
      database.urls.app,
      false,
      parseLocalServerConfig({
        LAUNDRY_ACCESS_TOKEN_SECRET: randomBytes(32).toString("hex"),
        LAUNDRY_CSRF_PROOF_SECRET: randomBytes(32).toString("hex"),
      }),
      {
        createPool: () => pool,
        assertReady: async () => {},
        loadStaffDirectory: async () => [
          {
            staff_id: staffId,
            display_name: "Photo fixture",
            role: "admin",
            username: "fixture",
            privacy_admin: true,
          },
        ],
      },
      {},
    );
    let revokeOnReuse = false;
    const runtime = {
      ...local,
      photo: {
        ...local.photo,
        files: {
          ...files,
          write: async (...args: Parameters<typeof files.write>) => {
            const stored = await files.write(...args);
            if (!stored.created && revokeOnReuse) {
              await admin.query("UPDATE staffs SET is_active=false WHERE id=$1", [staffId]);
            }
            return stored;
          },
        },
      },
    };
    const app = await createLocalApp({
      runtime,
      cookiePolicy: resolveCookiePolicy({ secure: false }),
      logger: false,
    });
    closeApp = () => app.close();
    const browserHeaders = {
      host: "127.0.0.1:8787",
      origin: "http://127.0.0.1:5173",
      "sec-fetch-site": "same-site",
    };
    const login = await app.inject({
      method: "POST",
      url: "/api/v2/auth/login",
      headers: browserHeaders,
      payload: {
        org_code: "local",
        store_code: "main",
        username: "fixture",
        password,
        device_id: randomUUID(),
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const rawCookies = login.headers["set-cookie"];
    const cookies = Object.fromEntries(
      (typeof rawCookies === "string" ? [rawCookies] : (rawCookies ?? [])).map((line) => {
        const pair = line.split(";", 1)[0] ?? "";
        const separator = pair.indexOf("=");
        return [pair.slice(0, separator), pair.slice(separator + 1)];
      }),
    );
    const headers = {
      ...browserHeaders,
      authorization: `Bearer ${login.json().data.access_token}`,
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      [CSRF_HEADER_NAME]: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
      "content-type": "image/jpeg",
    };
    const jpeg = await sharp({
      create: { width: 8, height: 6, channels: 3, background: "#5080b0" },
    })
      .jpeg()
      .toBuffer();
    const uploadId = randomUUID();
    const upload = (changes: Readonly<Record<string, string>> = {}) =>
      app.inject({
        method: "POST",
        url: `/api/v2/photos?${new URLSearchParams({
          upload_id: uploadId,
          order_id: orderId,
          garment_id: garmentId,
          kind: "receive",
          taken_at: "1784764800",
          ...changes,
        }).toString()}`,
        headers,
        payload: jpeg,
      });
    const first = await upload();
    assert.equal(first.statusCode, 200, first.body);
    const photoId = first.json().data.result.photo_id as string;
    const download = () => app.inject({ method: "GET", url: `/api/v2/photos/${photoId}`, headers });
    const original = (await download()).rawPayload;
    assert.deepEqual((await upload()).json(), first.json());
    for (const changes of [
      { kind: "defect" },
      { order_id: randomUUID() },
      { garment_id: randomUUID() },
      { taken_at: "1784764801" },
    ]) {
      const result = await upload(changes);
      assert.equal(result.statusCode, 400, result.body);
      assert.equal(result.json().error.code, "IDEMPOTENCY_CONFLICT");
      assert.deepEqual((await download()).rawPayload, original);
    }
    revokeOnReuse = true;
    assert.equal((await upload()).statusCode, 401);
    revokeOnReuse = false;
    await admin.query("UPDATE staffs SET is_active=true WHERE id=$1", [staffId]);
    assert.deepEqual((await download()).rawPayload, original);

    await admin.query(`CREATE FUNCTION photo_http_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.command='photo.register' THEN RAISE EXCEPTION 'synthetic photo audit failure'; END IF;
    RETURN NEW; END; $$;
    CREATE TRIGGER photo_http_audit_failure BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION photo_http_audit_failure()`);
    const retryId = randomUUID();
    const failure = await upload({ upload_id: retryId });
    assert.equal(failure.statusCode, 500, failure.body);
    assert.doesNotMatch(failure.body, /synthetic|storage_key|sha256/u);
    assert.equal((await local.photo.store.listByOrder(orgId, storeId, orderId)).length, 1);
    assert.equal((await readdir(files.rootPath)).includes(`${retryId}.jpg`), true);
    await admin.query(
      "DROP TRIGGER photo_http_audit_failure ON audit_log; DROP FUNCTION photo_http_audit_failure()",
    );
    const retry = await upload({ upload_id: retryId });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((await local.photo.store.listByOrder(orgId, storeId, orderId)).length, 2);
    assert.deepEqual((await download()).rawPayload, original);
    const audits = await admin.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_log WHERE command='photo.register'",
    );
    assert.equal(audits.rows[0]?.count, 2);
  },
);
