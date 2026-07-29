import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { CSRF_HEADER_NAME } from "@laundry/contracts";
import sharp from "sharp";

import {
  createMemoryLocalRuntime,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_STORE_ID,
} from "../local/demo-seed.js";
import { createPhotoFileStore, DEFAULT_MAX_PHOTO_BYTES } from "../photo/file-store.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLocalApp } from "./create-app.js";
import { createPhotoUploadLimiter } from "./photo-file-routes.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UPLOAD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELETE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const JPEG = await sharp({
  create: {
    width: 8,
    height: 6,
    channels: 3,
    background: { r: 90, g: 130, b: 180 },
  },
})
  .jpeg()
  .toBuffer();
const localCookies = resolveCookiePolicy({ secure: false });
const hostHeaders = Object.freeze({ host: "127.0.0.1:8787" });
const browserHeaders = Object.freeze({
  ...hostHeaders,
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});
const created: string[] = [];

after(async () => {
  await Promise.all(created.map((root) => rm(root, { recursive: true, force: true })));
});

function parseSetCookie(raw: string | string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of typeof raw === "string" ? [raw] : (raw ?? [])) {
    const pair = line.split(";", 1)[0];
    const separator = pair?.indexOf("=") ?? -1;
    if (pair !== undefined && separator > 0) {
      result[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return result;
}

async function buildApp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-photo-route-")));
  created.push(root);
  const files = await createPhotoFileStore({ rootPath: join(root, "photos") });
  const runtime = await createMemoryLocalRuntime();
  const patched = {
    ...runtime,
    photo: Object.freeze({ ...runtime.photo, files }),
  } as typeof runtime;
  const app = await createLocalApp({
    runtime: patched,
    cookiePolicy: localCookies,
    logger: false,
  });
  return { app, runtime: patched, files };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>["app"]) {
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
  const cookies = parseSetCookie(response.headers["set-cookie"]);
  const csrf = cookies[LOCAL_COOKIE_NAMES.csrf] ?? "";
  assert.notEqual(csrf, "");
  return Object.freeze({
    token: (response.json() as { data: { access_token: string } }).data.access_token,
    csrf,
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  });
}

function uploadUrl(): string {
  return (
    `/api/v2/photos?upload_id=${UPLOAD_ID}&order_id=${ORDER_ID}` +
    `&garment_id=${GARMENT_ID}&kind=receive`
  );
}

async function ownedPhotoNames(rootPath: string): Promise<readonly string[]> {
  return (await readdir(rootPath)).filter((name) => !name.startsWith(".laundry-photo-store"));
}

test("photo upload limiter bounds active sessions and evicts expired windows", () => {
  const allowUpload = createPhotoUploadLimiter();
  for (let index = 0; index < 5_000; index += 1) {
    assert.equal(allowUpload(`session-${index}`, 0), true);
  }
  assert.equal(allowUpload("new-session", 1), false);
  assert.equal(allowUpload("new-session", 60_000), true);

  for (let count = 1; count < 20; count += 1) {
    assert.equal(allowUpload("new-session", 60_000), true);
  }
  assert.equal(allowUpload("new-session", 60_000), false);
});

test("photo upload requires an authenticated CSRF-bound session", async () => {
  const { app, files } = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: uploadUrl(),
    headers: { ...browserHeaders, "content-type": "image/jpeg" },
    payload: JPEG,
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(await ownedPhotoNames(files.rootPath), []);
  await app.close();
});

test("uploads verified bytes, hides storage keys, and downloads only by photo id", async () => {
  const { app, runtime, files } = await buildApp();
  const auth = await login(app);
  const upload = await app.inject({
    method: "POST",
    url: uploadUrl(),
    headers: {
      ...browserHeaders,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
      [CSRF_HEADER_NAME]: auth.csrf,
      "content-type": "image/jpeg",
    },
    payload: JPEG,
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const result = upload.json() as {
    data: { result: { photo_id: string; storage_key?: unknown; content_type: string } };
  };
  assert.equal(result.data.result.storage_key, undefined);
  assert.equal(result.data.result.content_type, "image/jpeg");

  const records = await runtime.photo.store.listByOrder(DEMO_ORG_ID, DEMO_STORE_ID, ORDER_ID);
  const record = records[0];
  assert.ok(record);
  assert.equal(record.photo_id, result.data.result.photo_id);
  assert.equal((await ownedPhotoNames(files.rootPath)).length, 1);

  const download = await app.inject({
    method: "GET",
    url: `/api/v2/photos/${record.photo_id}`,
    headers: { ...hostHeaders, authorization: `Bearer ${auth.token}` },
  });
  assert.equal(download.statusCode, 200, download.body);
  assert.equal(download.headers["content-type"], "image/jpeg");
  assert.equal(download.headers["cache-control"], "private, no-store");
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  assert.notDeepEqual(download.rawPayload, JPEG);
  const normalizedMetadata = await sharp(download.rawPayload).metadata();
  assert.equal(normalizedMetadata.format, "jpeg");
  assert.equal(normalizedMetadata.exif, undefined);

  const thumbnail = await app.inject({
    method: "GET",
    url: `/api/v2/photos/${record.photo_id}/thumbnail`,
    headers: { ...hostHeaders, authorization: `Bearer ${auth.token}` },
  });
  assert.equal(thumbnail.statusCode, 200, thumbnail.body);
  assert.equal(thumbnail.headers["content-type"], "image/webp");
  assert.equal(thumbnail.headers["cache-control"], "private, no-store");
  const metadata = await sharp(thumbnail.rawPayload).metadata();
  assert.equal(metadata.format, "webp");
  assert.ok((metadata.width ?? 0) <= 320);
  assert.ok((metadata.height ?? 0) <= 320);

  const replay = await app.inject({
    method: "POST",
    url: uploadUrl(),
    headers: {
      ...browserHeaders,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
      [CSRF_HEADER_NAME]: auth.csrf,
      "content-type": "image/jpeg",
    },
    payload: JPEG,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(
    (replay.json() as { data: { result: { photo_id: string } } }).data.result.photo_id,
    record.photo_id,
  );
  assert.equal(
    (await runtime.photo.store.listByOrder(DEMO_ORG_ID, DEMO_STORE_ID, ORDER_ID)).length,
    1,
  );
  assert.equal((await ownedPhotoNames(files.rootPath)).length, 1);
  await app.close();
});

test("rejects disguised bytes and blocks direct metadata registration", async () => {
  const { app, files } = await buildApp();
  const auth = await login(app);
  const disguised = await app.inject({
    method: "POST",
    url: uploadUrl(),
    headers: {
      ...browserHeaders,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
      [CSRF_HEADER_NAME]: auth.csrf,
      "content-type": "image/jpeg",
    },
    payload: Buffer.from("<svg/>"),
  });
  assert.equal(disguised.statusCode, 415);
  assert.deepEqual(await ownedPhotoNames(files.rootPath), []);

  for (const command of ["photo.register", "photo.delete"]) {
    const direct = await app.inject({
      method: "POST",
      url: `/v1/commands/${command}`,
      headers: {
        ...browserHeaders,
        authorization: `Bearer ${auth.token}`,
        cookie: auth.cookie,
        [CSRF_HEADER_NAME]: auth.csrf,
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(direct.statusCode, 404);
  }
  await app.close();
});

test("deletes metadata and private bytes only through the audited route", async () => {
  const { app, runtime, files } = await buildApp();
  const auth = await login(app);
  const upload = await app.inject({
    method: "POST",
    url: uploadUrl(),
    headers: {
      ...browserHeaders,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
      [CSRF_HEADER_NAME]: auth.csrf,
      "content-type": "image/jpeg",
    },
    payload: JPEG,
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const photoId = (upload.json() as { data: { result: { photo_id: string } } }).data.result
    .photo_id;

  const deleted = await app.inject({
    method: "POST",
    url: `/api/v2/photos/${photoId}/delete`,
    headers: {
      ...browserHeaders,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
      [CSRF_HEADER_NAME]: auth.csrf,
      "content-type": "application/json",
    },
    payload: { delete_id: DELETE_ID },
  });

  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(
    (deleted.json() as { data: { result: { photo_id: string } } }).data.result.photo_id,
    photoId,
  );
  assert.deepEqual(await runtime.photo.store.listByOrder(DEMO_ORG_ID, DEMO_STORE_ID, ORDER_ID), []);
  assert.deepEqual(await ownedPhotoNames(files.rootPath), []);
  await app.close();
});

test("rejects oversized bodies before installing a file", async () => {
  const { app, files } = await buildApp();
  const auth = await login(app);
  const response = await app.inject({
    method: "POST",
    url: uploadUrl(),
    headers: {
      ...browserHeaders,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
      [CSRF_HEADER_NAME]: auth.csrf,
      "content-type": "image/jpeg",
    },
    payload: Buffer.alloc(DEFAULT_MAX_PHOTO_BYTES + 1, 0xff),
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(await ownedPhotoNames(files.rootPath), []);
  await app.close();
});

test("fails closed when stored bytes no longer match metadata", async () => {
  const { app, runtime, files } = await buildApp();
  const auth = await login(app);
  const upload = await app.inject({
    method: "POST",
    url: uploadUrl(),
    headers: {
      ...browserHeaders,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
      [CSRF_HEADER_NAME]: auth.csrf,
      "content-type": "image/jpeg",
    },
    payload: JPEG,
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const records = await runtime.photo.store.listByOrder(DEMO_ORG_ID, DEMO_STORE_ID, ORDER_ID);
  const record = records[0];
  assert.ok(record);
  await writeFile(join(files.rootPath, record.storage_key), Buffer.from(JPEG).fill(0xff, 4));

  const download = await app.inject({
    method: "GET",
    url: `/api/v2/photos/${record.photo_id}`,
    headers: { ...hostHeaders, authorization: `Bearer ${auth.token}` },
  });
  assert.equal(download.statusCode, 409);
  assert.doesNotMatch(download.body, /storage_key|sha256|photos/u);
  await app.close();
});
