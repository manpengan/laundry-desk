import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createMemoryLocalRuntime } from "../local/demo-seed.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { createPhotoFileStore } from "../photo/file-store.js";
import { createMemoryFulfillmentStore } from "../fulfillment/memory-store.js";
import { MemoryAiConversationStore } from "./streaming-memory-store.js";
import { createVisionService } from "./vision-service.js";
import { prepareVisionImages, visionCandidates } from "./vision-photos.js";
import type { AiProviderPort, AiProviderRequest } from "./streaming-provider.js";
import type { AiRequestContext } from "./streaming-store.js";
import type { AiVisionRequest } from "@laundry/contracts";

const context: AiRequestContext = {
  tenant: {
    orgId: LOCAL_PROFILE.orgId,
    storeId: LOCAL_PROFILE.storeId,
    staffId: LOCAL_PROFILE.adminStaffId,
  },
  authSessionId: randomUUID(),
  deviceId: randomUUID(),
  permissions: ["ai_use", "order_write"],
};
const analysis = { category: "上衣", colors: ["白"], visible_marks: ["无法判断"], comparisons: [] };
async function fixture() {
  const base = await createMemoryLocalRuntime();
  const root = await realpath(await mkdtemp(join(tmpdir(), "laundry-vision-")));
  const files = await createPhotoFileStore({ rootPath: root });
  const bytes = await sharp({
    create: { width: 700, height: 500, channels: 3, background: "white" },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "PRIVATE_CAMERA_OWNER" } } })
    .toBuffer();
  const photo = await files.write(bytes, "image/jpeg");
  const garmentId = randomUUID();
  const orderId = randomUUID();
  const row = await base.photo.store.register({
    ...photo,
    org_id: LOCAL_PROFILE.orgId,
    store_id: LOCAL_PROFILE.storeId,
    garment_id: garmentId,
    order_id: orderId,
    kind: "receive",
    taken_at: 1,
    created_by_staff_id: LOCAL_PROFILE.adminStaffId,
  });
  const foreign = await base.photo.store.register({
    ...photo,
    org_id: randomUUID(),
    store_id: randomUUID(),
    garment_id: randomUUID(),
    order_id: randomUUID(),
    kind: "receive",
    taken_at: 1,
    created_by_staff_id: randomUUID(),
  });
  const fulfillment = createMemoryFulfillmentStore({
    garments: [
      {
        org_id: LOCAL_PROFILE.orgId,
        store_id: LOCAL_PROFILE.storeId,
        garment_id: garmentId,
        order_id: orderId,
        ticket_no: "VISION-1",
        barcode: "VISION-BAR",
        customer_name: "PRIVATE_NAME",
        customer_phone_masked: "13800000111",
        service_code: "wash",
        category_code: "shirt",
        color: "white",
        brand: null,
        status: "washing",
        rack_zone: null,
        rack_slot: null,
        updated_at: 1,
        incident_count: 0,
      },
    ],
  });
  const runtime = {
    ...base,
    photo: { ...base.photo, files },
    fulfillment: { ...base.fulfillment, store: fulfillment, featureEnabled: async () => true },
  };
  const input: AiVisionRequest = {
    request_id: randomUUID(),
    mode: "assist",
    image_base64: bytes.toString("base64"),
    candidates: [],
    consent: true,
  };
  return {
    runtime,
    input,
    row,
    foreign,
    bytes,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
function provider(
  output = analysis,
  onRequest: (request: AiProviderRequest) => void = () => undefined,
): AiProviderPort {
  return {
    kind: "deterministic_fake",
    async *stream(request) {
      onRequest(request);
      yield { type: "delta", text: JSON.stringify(output) };
      yield { type: "end", finishReason: "stop", inputTokens: 700, outputTokens: 40 };
    },
  };
}
test("vision sends resized metadata-free images, preserves budget/audit and never persists photo bytes", async () => {
  const f = await fixture();
  const store = new MemoryAiConversationStore();
  const requests: AiProviderRequest[] = [];
  try {
    const service = createVisionService(f.runtime, store, async () =>
      provider(analysis, (request) => requests.push(request)),
    );
    const result = await service(f.input, context, new AbortController().signal);
    assert.equal(result.data.advisory_only, true);
    assert.equal(result.data.analysis.category, "上衣");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.tools, []);
    const image = requests[0]?.messages[0]?.images?.[0];
    assert.ok(image);
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    assert.ok((metadata.width ?? 999) <= 512);
    assert.equal(metadata.exif, undefined);
    assert.equal(JSON.stringify(requests).includes(f.row.photo_id), false);
    const saved = JSON.stringify(await store.listMessages(f.input.request_id, context));
    assert.equal(saved.includes(f.input.image_base64), false);
    assert.match(saved, /image_sha256/u);
    assert.equal(store.usageSnapshot()[0]?.inputTokens, 700);
    assert.equal(JSON.stringify(store.auditSnapshot()).includes(image.data), false);
    await assert.rejects(service(f.input, context, new AbortController().signal));
    assert.equal(requests.length, 1);
  } finally {
    await f.cleanup();
  }
});
test("candidate photos are tenant-scoped, hash-bound, small, and contain no customer data", async () => {
  const f = await fixture();
  try {
    const found = await visionCandidates(f.runtime, context, "VISION");
    assert.equal(found.data.candidates.length, 1);
    assert.equal(JSON.stringify(found).includes("PRIVATE_NAME"), false);
    assert.equal(JSON.stringify(found).includes("13800000111"), false);
    const match = {
      ...f.input,
      mode: "match" as const,
      candidates: [{ photo_id: f.row.photo_id, sha256: f.row.content_sha256! }],
    };
    assert.equal((await prepareVisionImages(f.runtime, context, match)).length, 2);
    await assert.rejects(
      prepareVisionImages(f.runtime, context, {
        ...match,
        candidates: [{ photo_id: f.row.photo_id, sha256: "0".repeat(64) }],
      }),
      /PHOTO_UNAVAILABLE/u,
    );
    await assert.rejects(
      prepareVisionImages(f.runtime, context, {
        ...match,
        candidates: [{ photo_id: f.foreign.photo_id, sha256: f.foreign.content_sha256! }],
      }),
      /PHOTO_UNAVAILABLE/u,
    );
    await assert.rejects(
      visionCandidates(f.runtime, { ...context, permissions: ["ai_use"] }, "VISION"),
      /DENIED/u,
    );
  } finally {
    await f.cleanup();
  }
});
test("vision refuses missing consent, invalid image, cancellation, invalid model output and tool execution", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const service = createVisionService(f.runtime, new MemoryAiConversationStore(), async () =>
      provider(analysis, () => {
        calls++;
      }),
    );
    await assert.rejects(
      service({ ...f.input, consent: false }, context, new AbortController().signal),
    );
    await assert.rejects(
      service(
        { ...f.input, image_base64: Buffer.from("not an image").toString("base64") },
        context,
        new AbortController().signal,
      ),
    );
    await assert.rejects(service(f.input, context, AbortSignal.abort()));
    assert.equal(calls, 0);
    const bad = createVisionService(f.runtime, new MemoryAiConversationStore(), async () =>
      provider({
        ...analysis,
        comparisons: [{ candidate_index: 1, similarity: "可能相似", reasons: ["颜色"] }],
      } as typeof analysis),
    );
    await assert.rejects(
      bad({ ...f.input, request_id: randomUUID() }, context, new AbortController().signal),
      /RESULT_INVALID/u,
    );
    const tools = createVisionService(f.runtime, new MemoryAiConversationStore(), async () => ({
      kind: "deterministic_fake",
      async *stream() {
        yield { type: "tool_call", callId: "bad", name: "operations.preview", args: {} };
      },
    }));
    await assert.rejects(
      tools({ ...f.input, request_id: randomUUID() }, context, new AbortController().signal),
      /UNAVAILABLE/u,
    );
  } finally {
    await f.cleanup();
  }
});
test("vision budget denial makes no provider inference request", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const store = new MemoryAiConversationStore({
      monthlyLimitMicros: 0,
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 4_000_000,
      circuitFailureThreshold: 3,
      circuitOpenMs: 300_000,
    });
    const service = createVisionService(f.runtime, store, async () =>
      provider(analysis, () => {
        calls++;
      }),
    );
    await assert.rejects(service(f.input, context, new AbortController().signal), /UNAVAILABLE/u);
    assert.equal(calls, 0);
  } finally {
    await f.cleanup();
  }
});

test("vision rejects a truncated result while preserving the provider usage debit", async () => {
  const f = await fixture();
  const store = new MemoryAiConversationStore();
  try {
    const service = createVisionService(f.runtime, store, async () => ({
      kind: "deterministic_fake",
      async *stream() {
        yield { type: "delta", text: JSON.stringify(analysis) };
        yield { type: "end", finishReason: "limit", inputTokens: 700, outputTokens: 512 };
      },
    }));
    await assert.rejects(service(f.input, context, new AbortController().signal), /UNAVAILABLE/u);
    assert.equal(store.usageSnapshot()[0]?.outputTokens, 512);
    assert.equal(store.usageSnapshot()[0]?.inputTokens, 700);
  } finally {
    await f.cleanup();
  }
});
