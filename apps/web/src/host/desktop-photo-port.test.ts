import assert from "node:assert/strict";
import test from "node:test";

import type { LaundryDesktopBridge } from "./desktop-bridge.js";
import { createDesktopPhotoPort } from "./desktop-photo-port.js";
import type { PhotoUploadInput } from "./photo-port.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GARMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const STAFF_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UPLOAD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DELETE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const BYTES = new Uint8Array([0xff, 0xd8, 0xff]);

function bridgeWithPhoto(photo: NonNullable<LaundryDesktopBridge["photo"]>): LaundryDesktopBridge {
  return Object.freeze({
    auth: Object.freeze({
      login: async () => ({ ok: false }),
      refresh: async () => ({ ok: false }),
      staffDirectory: async () => ({ ok: false }),
      pinChallenge: async () => ({ ok: false }),
      pinVerify: async () => ({ ok: false }),
      logout: async () => ({ ok: false }),
    }),
    command: Object.freeze({ execute: async () => ({ ok: false }) }),
    query: Object.freeze({ execute: async () => ({ ok: false }) }),
    photo,
    health: Object.freeze({ get: async () => ({ ok: false }) }),
  });
}

function uploadResult(extra: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    ok: true,
    data: {
      execution: "executed",
      result: {
        photo_id: PHOTO_ID,
        garment_id: GARMENT_ID,
        order_id: ORDER_ID,
        kind: "receive",
        content_type: "image/jpeg",
        byte_size: BYTES.byteLength,
        taken_at: 1_721_606_400,
        created_by_staff_id: STAFF_ID,
        ...extra,
      },
    },
  };
}

test("desktop PhotoPort copies bounded upload and download bytes", async () => {
  const captured: unknown[] = [];
  const port = createDesktopPhotoPort(
    bridgeWithPhoto(
      Object.freeze({
        upload: async (input: PhotoUploadInput) => {
          captured.push(input);
          return uploadResult();
        },
        read: async (input) => {
          captured.push(input);
          return { ok: true, data: { content_type: "image/jpeg", bytes: BYTES } };
        },
        delete: async (input) => {
          captured.push(input);
          return uploadResult();
        },
      }),
    ),
  );
  const uploadBytes = Uint8Array.from(BYTES);
  assert.equal(
    (
      await port.upload({
        upload_id: UPLOAD_ID,
        order_id: ORDER_ID,
        garment_id: GARMENT_ID,
        kind: "receive",
        content_type: "image/jpeg",
        bytes: uploadBytes,
      })
    ).ok,
    true,
  );
  const read = await port.read(PHOTO_ID, "thumbnail");
  const removed = await port.remove(PHOTO_ID, DELETE_ID);

  assert.equal(read.ok, true);
  assert.equal(removed.ok, true);
  if (!read.ok) return;
  assert.notEqual((captured[0] as { bytes: Uint8Array }).bytes, uploadBytes);
  assert.deepEqual(captured[1], { photo_id: PHOTO_ID, variant: "thumbnail" });
  assert.deepEqual(captured[2], { photo_id: PHOTO_ID, delete_id: DELETE_ID });
  assert.notEqual(read.data.bytes, BYTES);
  assert.deepEqual(read.data.bytes, BYTES);
});

test("desktop PhotoPort rejects malformed private or binary success data", async () => {
  const candidates: readonly unknown[] = [
    uploadResult({ photo_id: "not-a-uuid" }),
    uploadResult({ storage_key: "private.jpg" }),
  ];
  for (const candidate of candidates) {
    const port = createDesktopPhotoPort(
      bridgeWithPhoto(
        Object.freeze({
          upload: async () => candidate,
          read: async () => ({
            ok: true,
            data: { content_type: "text/html", bytes: BYTES },
          }),
          delete: async () => candidate,
        }),
      ),
    );
    assert.equal(
      (
        await port.upload({
          upload_id: UPLOAD_ID,
          order_id: ORDER_ID,
          garment_id: GARMENT_ID,
          kind: "receive",
          content_type: "image/jpeg",
          bytes: BYTES,
        })
      ).ok,
      false,
    );
    assert.equal((await port.read(PHOTO_ID, "original")).ok, false);
  }
});
