import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createCommandError, CSRF_HEADER_NAME } from "@laundry/contracts";
import sharp from "sharp";

import { HandlerCommandError } from "../bus/types.js";
import {
  createMemoryLocalRuntime,
  DEMO_ORG_ID,
  DEMO_PASSWORD,
  DEMO_STORE_ID,
} from "../local/demo-seed.js";
import { createPhotoFileStore, type PhotoFileStore } from "../photo/file-store.js";
import type { PhotoRegisterInput, PhotoStore } from "../photo/types.js";
import { resolveCookiePolicy } from "./cookie-policy.js";
import { createLocalApp } from "./create-app.js";
import { LOCAL_COOKIE_NAMES } from "./types.js";

const ORDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARMENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UPLOAD = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JPEG = await sharp({
  create: { width: 8, height: 6, channels: 3, background: { r: 90, g: 130, b: 180 } },
})
  .jpeg()
  .toBuffer();
const browserHeaders = Object.freeze({
  host: "127.0.0.1:8787",
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});

type Hooks = Readonly<{
  wrapStore?: (store: PhotoStore) => PhotoStore;
  wrapFiles?: (files: PhotoFileStore) => PhotoFileStore;
}>;

function delegateStore(store: PhotoStore): PhotoStore {
  return Object.freeze({
    register: (input) => store.register(input),
    findById: (...args) => store.findById(...args),
    listByOrder: (...args) => store.listByOrder(...args),
    deleteById: (...args) => store.deleteById(...args),
    listStorageKeys: (...args) => store.listStorageKeys(...args),
  });
}

async function fixture(t: TestContext, hooks: Hooks = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-photo-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await createPhotoFileStore({ rootPath: join(root, "photos") });
  const original = await createMemoryLocalRuntime();
  const store = delegateStore(original.photo.store);
  const runtime = {
    ...original,
    photo: {
      ...original.photo,
      store: hooks.wrapStore?.(store) ?? store,
      files: hooks.wrapFiles?.(files) ?? files,
    },
  };
  const app = await createLocalApp({
    runtime,
    cookiePolicy: resolveCookiePolicy({ secure: false }),
    logger: false,
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/v2/auth/login",
    headers: browserHeaders,
    payload: {
      org_code: "local",
      store_code: "main",
      username: "admin",
      password: DEMO_PASSWORD,
      device_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const auth = response.json() as {
    data: { access_token: string; session: { session_id: string; session_version: number } };
  };
  const rawCookies = response.headers["set-cookie"];
  const cookies = Object.fromEntries(
    (typeof rawCookies === "string" ? [rawCookies] : (rawCookies ?? [])).map((line) => {
      const pair = line.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
  const headers = {
    ...browserHeaders,
    authorization: `Bearer ${auth.data.access_token}`,
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    [CSRF_HEADER_NAME]: cookies[LOCAL_COOKIE_NAMES.csrf] ?? "",
    "content-type": "image/jpeg",
  };
  const upload = (changes: Readonly<Record<string, string>> = {}) =>
    app.inject({
      method: "POST",
      url: `/api/v2/photos?${new URLSearchParams({
        upload_id: UPLOAD,
        order_id: ORDER,
        garment_id: GARMENT,
        kind: "receive",
        taken_at: "1784764800",
        ...changes,
      }).toString()}`,
      headers,
      payload: JPEG,
    });
  return {
    app,
    runtime,
    files,
    store,
    upload,
    records: () => store.listByOrder(DEMO_ORG_ID, DEMO_STORE_ID, ORDER),
    names: async () => (await readdir(files.rootPath)).filter((name) => !name.startsWith(".")),
    download: (id: string) =>
      app.inject({
        method: "GET",
        url: `/api/v2/photos/${id}`,
        headers,
      }),
    revoke: () =>
      runtime.identity.sessions.sessions.revoke(
        auth.data.session.session_id,
        auth.data.session.session_version + 1,
        Math.floor(Date.now() / 1000),
      ),
  };
}

function denied(): never {
  throw new HandlerCommandError(createCommandError("PERMISSION_DENIED"));
}

for (const [field, value] of [
  ["kind", "other"],
  ["order_id", OTHER],
  ["garment_id", OTHER],
  ["taken_at", "1784764801"],
] as const) {
  test(`conflicting ${field} replay preserves the original row and downloadable bytes`, async (t) => {
    const f = await fixture(t);
    const first = await f.upload();
    assert.equal(first.statusCode, 200, first.body);
    const before = await f.records();
    const record = before[0];
    assert.ok(record);
    const originalBytes = (await f.download(record.photo_id)).rawPayload;
    const replay = await f.upload();
    assert.equal(replay.statusCode, 200, replay.body);
    assert.deepEqual(replay.json(), first.json());

    const conflict = await f.upload({ [field]: value });
    assert.equal(conflict.statusCode, 400, conflict.body);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
    assert.doesNotMatch(conflict.body, /storage_key|sha256|laundry-photo/u);
    assert.deepEqual(await f.records(), before);
    const download = await f.download(record.photo_id);
    assert.equal(download.statusCode, 200, download.body);
    assert.deepEqual(download.rawPayload, originalBytes);
    assert.deepEqual(await f.names(), [record.storage_key]);
  });
}

test("authorization lost after file reuse rejects replay without deleting the original", async (t) => {
  const f = await fixture(t, {
    wrapFiles: (files) => ({
      ...files,
      write: async (...args) => {
        const result = await files.write(...args);
        if (!result.created) await f.revoke();
        return result;
      },
    }),
  });
  assert.equal((await f.upload()).statusCode, 200);
  const before = await f.records();
  const record = before[0];
  assert.ok(record?.content_sha256);
  const bytes = (await f.files.read({ ...record, content_sha256: record.content_sha256 })).bytes;
  const retry = await f.upload();
  assert.equal(retry.statusCode, 401, retry.body);
  assert.deepEqual(await f.records(), before);
  assert.deepEqual(
    (await f.files.read({ ...record, content_sha256: record.content_sha256 })).bytes,
    bytes,
  );
});

test("definite registration rejection removes only its own unreferenced upload", async (t) => {
  const f = await fixture(t, {
    wrapStore: (store) => ({ ...store, register: async () => denied() }),
  });
  const response = await f.upload();
  assert.equal(response.statusCode, 403, response.body);
  assert.deepEqual(await f.records(), []);
  assert.deepEqual(await f.names(), []);
});

test("registration exception retains bytes when the metadata may already be committed", async (t) => {
  const f = await fixture(t, {
    wrapStore: (store) => ({
      ...store,
      register: async (input) => {
        await store.register(input);
        throw new Error("private photo registration failure");
      },
    }),
  });
  const failure = await f.upload();
  assert.equal(failure.statusCode, 500, failure.body);
  assert.doesNotMatch(failure.body, /private|registration failure|storage_key|sha256/u);
  const record = (await f.records())[0];
  assert.ok(record);
  assert.equal((await f.download(record.photo_id)).statusCode, 200);
  assert.equal((await f.records()).length, 1);
});

for (const failure of ["reference lookup", "file removal"] as const) {
  test(`failed ${failure} defers cleanup without disclosing private errors`, async (t) => {
    const f = await fixture(t, {
      wrapStore: (store) => ({
        ...store,
        register: async () => denied(),
        ...(failure === "reference lookup"
          ? {
              listStorageKeys: async () => {
                throw new Error("private database credentials");
              },
            }
          : {}),
      }),
      wrapFiles: (files) => ({
        ...files,
        ...(failure === "file removal"
          ? {
              remove: async () => {
                throw new Error("private filesystem path");
              },
            }
          : {}),
      }),
    });
    const result = await f.upload();
    assert.equal(result.statusCode, 403, result.body);
    assert.doesNotMatch(result.body, /private|credentials|filesystem|storage_key|sha256/u);
    assert.deepEqual(await f.names(), [`${UPLOAD}.jpg`]);
  });
}

for (const failFirst of [true, false]) {
  test(`concurrent HTTP success and rejection preserve the successful photo (failure first: ${failFirst})`, async (t) => {
    let registrations = 0;
    const f = await fixture(t, {
      wrapStore: (store) => ({
        ...store,
        register: async (input: PhotoRegisterInput) => {
          const attempt = registrations++;
          await new Promise<void>((resolve) => setImmediate(resolve));
          if ((attempt === 0) === failFirst) denied();
          return store.register(input);
        },
      }),
    });
    // Different kinds ensure one request conflicts even if success wins first.
    const responses = await Promise.all([f.upload(), f.upload({ kind: "other" })]);
    assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
    assert.equal(responses.filter((response) => response.statusCode >= 400).length, 1);
    const records = await f.records();
    assert.equal(records.length, 1);
    assert.ok(records[0]);
    assert.equal((await f.download(records[0].photo_id)).statusCode, 200);
    assert.deepEqual(await f.names(), [records[0].storage_key]);
  });
}
