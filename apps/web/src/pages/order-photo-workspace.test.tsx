import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider } from "@laundry/ui";
import type { CommandResult, QueryPort } from "../commands/types.js";
import type { PhotoPort, PhotoUploadData, PhotoUploadInput } from "../host/photo-port.js";
import { OrderPhotoWorkspace } from "./OrderPhotoWorkspace.js";
import type { PhotoOrder } from "./use-order-photos.js";
import type { PhotoMetaRow } from "./photo-list.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GARMENTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;
const order = (id = ORDER_A): PhotoOrder => ({
  order_id: id,
  garments: GARMENTS.map((garment_id, index) => ({
    garment_id,
    barcode: `衣物-${index + 1}`,
    status: "received",
    line_index: 0,
    seq: index + 1,
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1000,
    color: ["白", "蓝", "黑"][index] ?? null,
    brand: null,
    defects: [],
    accessories: [],
    note: null,
    addons: [],
    rack_zone: null,
    rack_slot: null,
  })),
});
const photo = (orderId = ORDER_A): PhotoMetaRow => ({
  photo_id: "99999999-9999-4999-8999-999999999999",
  order_id: orderId,
  garment_id: GARMENTS[1],
  kind: "defect",
  content_type: "image/png",
  byte_size: 3,
  taken_at: 0,
});
const success = (input: PhotoUploadInput): CommandResult<PhotoUploadData> => ({
  ok: true,
  data: {
    execution: "executed",
    result: {
      photo_id: "99999999-9999-4999-8999-999999999999",
      order_id: input.order_id,
      garment_id: input.garment_id,
      kind: input.kind,
      content_type: input.content_type,
      byte_size: input.bytes.byteLength,
      taken_at: 0,
      created_by_staff_id: "88888888-8888-4888-8888-888888888888",
    },
  },
});
const failure = { ok: false, error: { code: "NETWORK", message: "连接中断，请重试" } } as const;
const emptyQuery: QueryPort = {
  async execute<T>() {
    return { ok: true, data: { photos: [] } as T };
  },
};
function port(upload: PhotoPort["upload"]): PhotoPort {
  return { upload, read: async () => failure, remove: async () => failure };
}
function tree(currentOrder: PhotoOrder, query: QueryPort, photoPort: PhotoPort) {
  return createElement(
    ToastProvider,
    null,
    createElement(OrderPhotoWorkspace, {
      order: currentOrder,
      queryClient: query,
      photoPort,
    }),
  );
}
function select(renderer: ReactTestRenderer, label: string, value: string) {
  const node = renderer.root.findByProps({ "aria-label": label });
  (node.props.onChange as (event: { currentTarget: { value: string } }) => void)({
    currentTarget: { value },
  });
}
function upload(renderer: ReactTestRenderer) {
  const node = renderer.root.findByProps({ "data-testid": "order-detail-register-photo-btn" });
  assert.equal(node.props.disabled, false);
  (node.props.onChange as (event: { currentTarget: { files: File[]; value: string } }) => void)({
    currentTarget: {
      files: [new File([new Uint8Array([1, 2, 3])], "衣物.png", { type: "image/png" })],
      value: "selected",
    },
  });
}
function click(renderer: ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType("button")
    .find((item) => item.children.join("") === label);
  assert.ok(node, label);
  (node.props.onClick as () => void)();
}
async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("three garments require a choice; upload and gallery preserve selected garment and kind", async () => {
  const requests: PhotoUploadInput[] = [];
  let photos: readonly PhotoMetaRow[] = [];
  const photoPort = port(async (input) => {
    requests.push(input);
    photos = [{ ...photo(), garment_id: input.garment_id, kind: input.kind }];
    return success(input);
  });
  const query: QueryPort = {
    async execute<T>() {
      return { ok: true, data: { photos } as T };
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(order(), query, photoPort));
  });
  try {
    assert.equal(
      renderer.root.findByProps({ "data-testid": "order-detail-register-photo-btn" }).props
        .disabled,
      true,
    );
    assert.equal(
      renderer.root
        .findAllByType("option")
        .filter((item) => GARMENTS.includes(item.props.value as (typeof GARMENTS)[number])).length,
      3,
    );
    await act(async () => {
      select(renderer, "照片对应衣物", GARMENTS[2]);
      select(renderer, "照片种类", "ready");
    });
    await act(async () => {
      upload(renderer);
      await flush();
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.garment_id, GARMENTS[2]);
    assert.equal(requests[0]?.kind, "ready");
    const thumb = renderer.root.findByProps({ "data-testid": "order-detail-photo-thumb" });
    assert.match(thumb.props.title as string, /衣物-3.*黑.*洗后/u);
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("failure retry retains original garment, kind, bytes and upload identity after selection changes", async () => {
  const requests: PhotoUploadInput[] = [];
  const photoPort = port(async (input) => {
    requests.push(input);
    return requests.length === 1 ? failure : success(input);
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(order(), emptyQuery, photoPort));
  });
  try {
    await act(async () => {
      select(renderer, "照片对应衣物", GARMENTS[1]);
      select(renderer, "照片种类", "defect");
    });
    await act(async () => {
      upload(renderer);
      await flush();
    });
    assert.match(JSON.stringify(renderer.toJSON()), /重试仍保存到：/u);
    await act(async () => {
      select(renderer, "照片对应衣物", GARMENTS[2]);
      select(renderer, "照片种类", "ready");
    });
    assert.equal(
      renderer.root.findByProps({ "data-testid": "order-detail-register-photo-btn" }).props
        .disabled,
      true,
    );
    await act(async () => {
      click(renderer, "重试上传");
      await flush();
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(requests[1]?.garment_id, GARMENTS[1]);
    assert.equal(requests[1]?.kind, "defect");
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /重试仍保存到：/u);
  } finally {
    await act(async () => renderer.unmount());
  }
});

for (const succeeds of [true, false]) {
  test(`late ${succeeds ? "success" : "failure"} from order A cannot change order B or reload A`, async () => {
    const reads: unknown[] = [];
    const query: QueryPort = {
      async execute<T>(_name: string, body?: unknown) {
        reads.push(body);
        return { ok: true, data: { photos: [] } as T };
      },
    };
    let resolveUpload!: (value: CommandResult<PhotoUploadData>) => void;
    let pendingInput!: PhotoUploadInput;
    const photoPort = port((input) => {
      pendingInput = input;
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(tree(order(), query, photoPort));
    });
    try {
      await act(async () => select(renderer, "照片对应衣物", GARMENTS[1]));
      await act(async () => {
        upload(renderer);
        await flush();
      });
      await act(async () => renderer.update(tree(order(ORDER_B), query, photoPort)));
      await act(async () => {
        resolveUpload(succeeds ? success(pendingInput) : failure);
        await flush();
      });
      assert.deepEqual(reads, [{ order_id: ORDER_A }, { order_id: ORDER_B }]);
      assert.equal(renderer.root.findByProps({ "aria-label": "照片对应衣物" }).props.value, "");
      const json = JSON.stringify(renderer.toJSON());
      assert.doesNotMatch(json, /重试上传|照片已安全保存|连接中断/u);
      assert.match(json, /暂无照片/u);
    } finally {
      await act(async () => renderer.unmount());
    }
  });
}

test("late order A photo list does not populate order B and wrong-order lists are rejected", async () => {
  let resolveList!: (value: CommandResult<unknown>) => void;
  const query: QueryPort = {
    async execute<T>(_name: string, body?: unknown) {
      if ((body as { order_id: string }).order_id === ORDER_A)
        return new Promise<CommandResult<T>>((resolve) => {
          resolveList = resolve as typeof resolveList;
        });
      return { ok: true, data: { photos: [photo()] } as T };
    },
  };
  const photoPort = port(async (input) => success(input));
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(order(), query, photoPort));
  });
  try {
    await act(async () => renderer.update(tree(order(ORDER_B), query, photoPort)));
    await act(async () => resolveList({ ok: true, data: { photos: [photo()] } }));
    assert.match(JSON.stringify(renderer.toJSON()), /照片列表响应格式错误/u);
    assert.equal(
      renderer.root.findAllByProps({ "data-testid": "order-detail-photo-thumb" }).length,
      0,
    );
  } finally {
    await act(async () => renderer.unmount());
  }
});

test("closing an order before bytes finish reading does not start its upload", async () => {
  let readBytes!: (value: ArrayBuffer) => void;
  const file = new File([new Uint8Array([1])], "衣物.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        readBytes = resolve;
      }),
  });
  let uploads = 0;
  const photoPort = port(async (input) => {
    uploads++;
    return success(input);
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree(order(), emptyQuery, photoPort));
  });
  await act(async () => select(renderer, "照片对应衣物", GARMENTS[0]));
  await act(async () => {
    const node = renderer.root.findByProps({ "data-testid": "order-detail-register-photo-btn" });
    (node.props.onChange as (event: { currentTarget: { files: File[]; value: string } }) => void)({
      currentTarget: { files: [file], value: "selected" },
    });
  });
  await act(async () => renderer.unmount());
  await act(async () => readBytes(new Uint8Array([1]).buffer));
  assert.equal(uploads, 0);
});
