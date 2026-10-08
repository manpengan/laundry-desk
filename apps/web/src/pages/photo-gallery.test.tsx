import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement, useLayoutEffect } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { PhotoPort } from "../host/photo-port.js";
import { PhotoGallery } from "./PhotoGallery.js";
import type { PhotoMetaRow } from "./photo-list.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const PHOTO: PhotoMetaRow = {
  photo_id: "11111111-1111-4111-8111-111111111111",
  order_id: "22222222-2222-4222-8222-222222222222",
  garment_id: "33333333-3333-4333-8333-333333333333",
  kind: "receive",
  content_type: "image/png",
  byte_size: 3,
  taken_at: 0,
};
const SECOND_PHOTO: PhotoMetaRow = {
  ...PHOTO,
  photo_id: "44444444-4444-4444-8444-444444444444",
  kind: "ready",
};
const READ_SUCCESS: Awaited<ReturnType<PhotoPort["read"]>> = {
  ok: true,
  data: { content_type: "image/png", bytes: Uint8Array.from([1, 2, 3]) },
};
const FAILURE = { ok: false, error: { code: "NETWORK", message: "照片读取失败" } } as const;

function photoPort(read: PhotoPort["read"]): PhotoPort {
  return { read, upload: async () => FAILURE, remove: async () => FAILURE };
}

function mockUrls(context: TestContext) {
  let sequence = 0;
  return {
    created: context.mock.method(URL, "createObjectURL", () => `blob:photo-${++sequence}`),
    revoked: context.mock.method(URL, "revokeObjectURL", () => undefined),
  };
}

function deferredRead() {
  let resolve!: (result: Awaited<ReturnType<PhotoPort["read"]>>) => void;
  const promise = new Promise<Awaited<ReturnType<PhotoPort["read"]>>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount(
  port: PhotoPort,
  photos: readonly PhotoMetaRow[] = [PHOTO],
  onDelete?: (photoId: string) => Promise<boolean>,
) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(PhotoGallery, {
        photos,
        photoPort: port,
        ...(onDelete === undefined ? {} : { onDelete }),
      }),
    );
  });
  return renderer;
}

function click(root: ReactTestInstance, label: string) {
  const button = root.findAllByType("button").find((item) => item.children.join("") === label);
  assert.ok(button, label);
  (button.props.onClick as () => void)();
}

function openPhoto(renderer: ReactTestRenderer, index = 0) {
  const button = renderer.root.findAllByProps({ className: "ld-photo-image__open" })[index];
  assert.ok(button);
  (button.props.onClick as () => void)();
}

function errorCallback(image: ReactTestInstance): () => void {
  assert.equal(typeof image.props.onError, "function");
  return image.props.onError as () => void;
}

test("thumbnail decode failure retries with new bytes and ignores obsolete image errors", async (context) => {
  const urls = mockUrls(context);
  const retry = deferredRead();
  let readCount = 0;
  const read = context.mock.fn<PhotoPort["read"]>(async () => {
    readCount += 1;
    return readCount === 1 ? READ_SUCCESS : retry.promise;
  });
  const renderer = await mount(photoPort(read));
  try {
    const image = renderer.root.findByType("img");
    assert.equal(image.props.alt, "收衣 照片缩略图");
    const oldError = errorCallback(image);
    await act(async () => oldError());
    assert.equal(renderer.root.findAllByType("img").length, 0);
    assert.ok(
      renderer.root
        .findByProps({ role: "alert" })
        .findAllByType("span")
        .some((span) => span.children.join("") === "照片显示失败，请重试"),
    );

    await act(async () => click(renderer.root, "重试"));
    assert.deepEqual(
      read.mock.calls.map((call) => call.arguments),
      [
        [PHOTO.photo_id, "thumbnail"],
        [PHOTO.photo_id, "thumbnail"],
      ],
    );
    assert.deepEqual(
      urls.revoked.mock.calls.map((call) => call.arguments),
      [["blob:photo-1"]],
    );
    await act(async () => oldError());
    assert.equal(renderer.root.findAllByProps({ role: "alert" }).length, 0);
    assert.equal(
      renderer.root.findByProps({ className: "ld-photo-image__status" }).children[0],
      "加载中…",
    );

    await act(async () => retry.resolve(READ_SUCCESS));
    assert.equal(renderer.root.findByType("img").props.src, "blob:photo-2");
    await act(async () => oldError());
    assert.equal(renderer.root.findByType("img").props.src, "blob:photo-2");
  } finally {
    await act(async () => renderer.unmount());
  }
  assert.deepEqual(
    urls.revoked.mock.calls.map((call) => call.arguments),
    [["blob:photo-1"], ["blob:photo-2"]],
  );
});

test("original decode failure and retry leave the thumbnail usable", async (context) => {
  const urls = mockUrls(context);
  const read = context.mock.fn<PhotoPort["read"]>(async () => READ_SUCCESS);
  const renderer = await mount(photoPort(read));
  try {
    await act(async () => openPhoto(renderer));
    const viewer = renderer.root.findByProps({ role: "dialog" });
    const oldError = errorCallback(viewer.findByType("img"));
    assert.equal(viewer.findByType("img").props.alt, "收衣 照片");
    await act(async () => oldError());
    assert.equal(viewer.findAllByType("img").length, 0);
    assert.equal(viewer.findAllByProps({ role: "alert" }).length, 1);
    assert.equal(renderer.root.findByProps({ alt: "收衣 照片缩略图" }).props.src, "blob:photo-1");

    await act(async () => click(viewer, "重试"));
    assert.equal(viewer.findByType("img").props.src, "blob:photo-3");
    await act(async () => oldError());
    assert.equal(viewer.findByType("img").props.src, "blob:photo-3");
    assert.deepEqual(
      read.mock.calls.map((call) => call.arguments),
      [
        [PHOTO.photo_id, "thumbnail"],
        [PHOTO.photo_id, "original"],
        [PHOTO.photo_id, "original"],
      ],
    );
    await act(async () => click(viewer, "关闭照片"));
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
    assert.equal(renderer.root.findByType("img").props.src, "blob:photo-1");
  } finally {
    await act(async () => renderer.unmount());
  }
  assert.deepEqual(
    urls.revoked.mock.calls.map((call) => call.arguments),
    [["blob:photo-2"], ["blob:photo-3"], ["blob:photo-1"]],
  );
});

test("viewer Escape consumes the ancestor key event and releases only the original", async (context) => {
  const urls = mockUrls(context);
  const renderer = await mount(photoPort(async () => READ_SUCCESS));
  try {
    await act(async () => openPhoto(renderer));
    const viewer = renderer.root.findByProps({ role: "dialog" });
    const event = {
      key: "Escape",
      preventDefault: context.mock.fn(),
      stopPropagation: context.mock.fn(),
    };
    await act(async () => {
      (viewer.props.onKeyDown as (keyEvent: typeof event) => void)(event);
    });
    assert.equal(event.preventDefault.mock.callCount(), 1);
    assert.equal(event.stopPropagation.mock.callCount(), 1);
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
    assert.equal(renderer.root.findByType("img").props.src, "blob:photo-1");
    assert.deepEqual(
      urls.revoked.mock.calls.map((call) => call.arguments),
      [["blob:photo-2"]],
    );
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("Escape cannot dismiss a viewer while its confirmed deletion is pending", async (context) => {
  mockUrls(context);
  let finishDelete!: (removed: boolean) => void;
  const pending = new Promise<boolean>((resolve) => {
    finishDelete = resolve;
  });
  const remove = context.mock.fn(async () => pending);
  const renderer = await mount(
    photoPort(async () => READ_SUCCESS),
    [PHOTO],
    remove,
  );
  try {
    await act(async () => openPhoto(renderer));
    const viewer = renderer.root.findByProps({ role: "dialog" });
    await act(async () => click(viewer, "删除照片"));
    await act(async () => click(viewer, "确认删除"));
    assert.equal(remove.mock.callCount(), 1);
    assert.equal(viewer.findByProps({ className: "ld-photo-viewer__close" }).props.disabled, true);
    const event = {
      key: "Escape",
      preventDefault: context.mock.fn(),
      stopPropagation: context.mock.fn(),
    };
    await act(async () => {
      (viewer.props.onKeyDown as (keyEvent: typeof event) => void)(event);
    });
    assert.equal(event.stopPropagation.mock.callCount(), 1);
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 1);
    await act(async () => finishDelete(true));
    assert.equal(renderer.root.findAllByProps({ role: "dialog" }).length, 0);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("switching the selected original hides the prior image and ignores its late error", async (context) => {
  const urls = mockUrls(context);
  const secondOriginal = deferredRead();
  const read: PhotoPort["read"] = async (photoId, variant) =>
    photoId === SECOND_PHOTO.photo_id && variant === "original"
      ? secondOriginal.promise
      : READ_SUCCESS;
  const renderer = await mount(photoPort(read), [PHOTO, SECOND_PHOTO]);
  try {
    await act(async () => openPhoto(renderer));
    const viewer = renderer.root.findByProps({ role: "dialog" });
    const oldError = errorCallback(viewer.findByType("img"));
    assert.equal(viewer.findByType("img").props.src, "blob:photo-3");
    await act(async () => openPhoto(renderer, 1));
    assert.equal(viewer.findAllByType("img").length, 0);
    assert.equal(
      viewer.findByProps({ className: "ld-photo-image__status" }).children[0],
      "加载中…",
    );
    assert.deepEqual(
      urls.revoked.mock.calls.map((call) => call.arguments),
      [["blob:photo-3"]],
    );
    await act(async () => oldError());
    assert.equal(viewer.findAllByProps({ role: "alert" }).length, 0);
    await act(async () => secondOriginal.resolve(READ_SUCCESS));
    assert.equal(viewer.findByType("img").props.alt, "洗后 照片");
    assert.equal(viewer.findByType("img").props.src, "blob:photo-4");
    await act(async () => oldError());
    assert.equal(viewer.findByType("img").props.src, "blob:photo-4");
  } finally {
    await act(async () => renderer.unmount());
  }
  assert.equal(urls.created.mock.callCount(), 4);
  assert.equal(urls.revoked.mock.callCount(), 4);
});

test("late read completion from a previously selected original cannot replace the current photo", async (context) => {
  const urls = mockUrls(context);
  const firstOriginal = deferredRead();
  const read: PhotoPort["read"] = async (photoId, variant) =>
    photoId === PHOTO.photo_id && variant === "original" ? firstOriginal.promise : READ_SUCCESS;
  const renderer = await mount(photoPort(read), [PHOTO, SECOND_PHOTO]);
  try {
    await act(async () => openPhoto(renderer));
    await act(async () => openPhoto(renderer, 1));
    const viewer = renderer.root.findByProps({ role: "dialog" });
    assert.equal(viewer.findByType("img").props.alt, "洗后 照片");
    assert.equal(viewer.findByType("img").props.src, "blob:photo-3");
    await act(async () => firstOriginal.resolve(READ_SUCCESS));
    assert.equal(viewer.findByType("img").props.src, "blob:photo-3");
    assert.equal(urls.created.mock.callCount(), 3);
  } finally {
    await act(async () => renderer.unmount());
  }
  assert.equal(urls.revoked.mock.callCount(), 3);
});

test("a changed photo port never commits the preceding port's image as current", async (context) => {
  mockUrls(context);
  const pending = deferredRead();
  const initialPort = photoPort(async () => READ_SUCCESS);
  const replacementPort = photoPort(async () => pending.promise);
  let renderer!: ReactTestRenderer;
  let committedSources: readonly string[] = [];
  function ObserveGallery({ port }: Readonly<{ port: PhotoPort }>) {
    useLayoutEffect(() => {
      committedSources = renderer.root
        .findAllByType("img")
        .map((image) => image.props.src as string);
    }, [port]);
    return createElement(PhotoGallery, { photos: [PHOTO], photoPort: port });
  }
  await act(async () => {
    renderer = create(createElement(ObserveGallery, { port: initialPort }));
  });
  try {
    assert.equal(renderer.root.findByType("img").props.src, "blob:photo-1");
    await act(async () => {
      renderer.update(createElement(ObserveGallery, { port: replacementPort }));
    });
    assert.deepEqual(committedSources, []);
    await act(async () => pending.resolve(READ_SUCCESS));
    assert.equal(renderer.root.findByType("img").props.src, "blob:photo-2");
  } finally {
    await act(async () => renderer.unmount());
  }
});
