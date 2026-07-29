import assert from "node:assert/strict";
import test from "node:test";

import { createHttpPhotoPort, MAX_PHOTO_BYTES } from "./photo-port.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STAFF_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UPLOAD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELETE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PHOTO_DATA = Object.freeze({
  execution: "executed",
  result: Object.freeze({
    photo_id: PHOTO_ID,
    garment_id: GARMENT_ID,
    order_id: ORDER_ID,
    kind: "receive",
    content_type: "image/jpeg",
    byte_size: JPEG.byteLength,
    taken_at: 1_721_606_400,
    created_by_staff_id: STAFF_ID,
  }),
});

test("browser PhotoPort owns credentials and sends only fixed raw upload fields", async () => {
  const observed: Array<Readonly<{ url: string; request: RequestInit }>> = [];
  const port = createHttpPhotoPort({
    apiBaseUrl: "http://127.0.0.1:8787/",
    getAccessToken: () => "access.secret",
    readCsrf: () => "csrf-proof",
    fetchImpl: async function (this: unknown, input, request = {}) {
      assert.equal(this, undefined);
      observed.push({ url: String(input), request });
      return new Response(
        JSON.stringify({
          ok: true,
          data: PHOTO_DATA,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await port.upload({
    upload_id: UPLOAD_ID,
    order_id: ORDER_ID,
    garment_id: GARMENT_ID,
    kind: "receive",
    content_type: "image/jpeg",
    bytes: JPEG,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.result.photo_id, PHOTO_ID);
  const upload = observed[0];
  assert.ok(upload);
  assert.equal(upload.request.method, "POST");
  const headers = upload.request.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer access.secret");
  assert.equal(headers["x-csrf-token"], "csrf-proof");
  assert.equal(headers["content-type"], "image/jpeg");
  assert.match(upload.url, /^http:\/\/127\.0\.0\.1:8787\/api\/v2\/photos\?/u);
  assert.equal(new URL(upload.url).searchParams.get("upload_id"), UPLOAD_ID);
  assert.equal(upload.url.includes("access.secret"), false);
  assert.ok(upload.request.body instanceof Blob);
  assert.deepEqual(new Uint8Array(await upload.request.body.arrayBuffer()), JPEG);
});

test("browser PhotoPort rejects malformed and storage-bearing success payloads", async () => {
  const candidates = [
    { ...PHOTO_DATA, result: { ...PHOTO_DATA.result, photo_id: "not-a-uuid" } },
    { ...PHOTO_DATA, result: { ...PHOTO_DATA.result, storage_key: `${PHOTO_ID}.jpg` } },
  ];
  let index = 0;
  const port = createHttpPhotoPort({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "access.secret",
    readCsrf: () => "csrf-proof",
    fetchImpl: async () =>
      new Response(JSON.stringify({ ok: true, data: candidates[index++] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  for (const candidate of candidates) {
    void candidate;
    const result = await port.upload({
      upload_id: UPLOAD_ID,
      order_id: ORDER_ID,
      garment_id: GARMENT_ID,
      kind: "receive",
      content_type: "image/jpeg",
      bytes: JPEG,
    });
    assert.deepEqual(result, {
      ok: false,
      error: { code: "PHOTO_UPLOAD_FAILED", message: "照片上传响应格式错误" },
    });
  }
});

test("browser PhotoPort rejects invalid or oversized bytes before network access", async () => {
  let requests = 0;
  const port = createHttpPhotoPort({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "access.secret",
    readCsrf: () => "csrf-proof",
    fetchImpl: async () => {
      requests += 1;
      return new Response();
    },
  });

  for (const bytes of [new Uint8Array(), new Uint8Array(MAX_PHOTO_BYTES + 1)]) {
    const result = await port.upload({
      upload_id: UPLOAD_ID,
      order_id: ORDER_ID,
      garment_id: GARMENT_ID,
      kind: "receive",
      content_type: "image/jpeg",
      bytes,
    });
    assert.equal(result.ok, false);
  }
  assert.equal(requests, 0);
});

test("browser PhotoPort reads bounded thumbnails with bearer credentials", async () => {
  const observed: Array<Readonly<{ url: string; request: RequestInit }>> = [];
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  const port = createHttpPhotoPort({
    apiBaseUrl: "http://127.0.0.1:8787/",
    getAccessToken: () => "access.secret",
    readCsrf: () => "unused-for-read",
    fetchImpl: async (input, request = {}) => {
      observed.push({ url: String(input), request });
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "image/webp",
          "content-length": String(bytes.byteLength),
        },
      });
    },
  });

  const result = await port.read(PHOTO_ID, "thumbnail");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data, { content_type: "image/webp", bytes });
  assert.notEqual(result.data.bytes, bytes);
  assert.deepEqual(observed, [
    {
      url: `http://127.0.0.1:8787/api/v2/photos/${PHOTO_ID}/thumbnail`,
      request: {
        method: "GET",
        credentials: "include",
        headers: { authorization: "Bearer access.secret" },
      },
    },
  ]);
});

test("browser PhotoPort rejects invalid identifiers and unsafe binary responses", async () => {
  let responseType = "text/html";
  let requests = 0;
  const port = createHttpPhotoPort({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "access.secret",
    readCsrf: () => null,
    fetchImpl: async () => {
      requests += 1;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": responseType },
      });
    },
  });

  assert.equal((await port.read("not-a-uuid", "thumbnail")).ok, false);
  assert.equal(requests, 0);
  assert.equal((await port.read(PHOTO_ID, "thumbnail")).ok, false);
  responseType = "image/jpeg";
  assert.equal((await port.read(PHOTO_ID, "invalid" as unknown as "thumbnail")).ok, false);
  assert.equal(requests, 1);
});

test("browser PhotoPort cancels an unbounded response before buffering past the byte cap", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(5 * 1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const port = createHttpPhotoPort({
    apiBaseUrl: "http://127.0.0.1:8787",
    getAccessToken: () => "access.secret",
    readCsrf: () => null,
    fetchImpl: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
  });

  const result = await port.read(PHOTO_ID, "original");

  assert.equal(result.ok, false);
  assert.equal(cancelled, true);
  assert.ok(pulls >= 2 && pulls <= 3);
});

test("browser PhotoPort deletes through the fixed authenticated mutation route", async () => {
  const observed: Array<Readonly<{ url: string; request: RequestInit }>> = [];
  const port = createHttpPhotoPort({
    apiBaseUrl: "http://127.0.0.1:8787/",
    getAccessToken: () => "access.secret",
    readCsrf: () => "csrf-proof",
    fetchImpl: async (input, request = {}) => {
      observed.push({ url: String(input), request });
      return new Response(JSON.stringify({ ok: true, data: PHOTO_DATA }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await port.remove(PHOTO_ID, DELETE_ID);

  assert.equal(result.ok, true);
  assert.deepEqual(observed, [
    {
      url: `http://127.0.0.1:8787/api/v2/photos/${PHOTO_ID}/delete`,
      request: {
        method: "POST",
        credentials: "include",
        headers: {
          authorization: "Bearer access.secret",
          "content-type": "application/json",
          "x-csrf-token": "csrf-proof",
        },
        body: JSON.stringify({ delete_id: DELETE_ID }),
      },
    },
  ]);
});
