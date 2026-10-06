import assert from "node:assert/strict";
import test from "node:test";
import { liveConnection } from "./use-live-connection.js";
const ready = { ok: true as const, data: { status: "ready" as const } };
const empty = { ok: true as const, data: { pendingCount: 0, inflightCount: 0, conflicts: [] } };

test("offline or unknown queue never claims everything is synced", () => {
  for (const status of [
    liveConnection(null, empty, false),
    liveConnection(ready, empty, true),
    liveConnection(ready, null, false),
  ]) {
    assert.notEqual(status.mode, "online");
    assert.notEqual(status.detail, "全部已同步");
  }
  assert.equal(liveConnection(ready, undefined, false).detail, "本机服务已连接");
  assert.equal(liveConnection(ready, undefined, false).pendingSyncCount, null);
});
test("known queues report pending writes and conflicts instead of a reassuring zero", () => {
  assert.equal(liveConnection(ready, empty, false).detail, "全部已同步");
  assert.equal(
    liveConnection(
      ready,
      { ok: true, data: { pendingCount: 2, inflightCount: 1, conflicts: [] } },
      false,
    ).pendingSyncCount,
    3,
  );
  const conflicted = liveConnection(
    ready,
    {
      ok: true,
      data: {
        ...empty.data,
        conflicts: [
          {
            queueId: "q",
            command: "order.receive",
            errorCode: "CONFLICT",
            createdAt: "2026-10-05",
          },
        ],
      },
    },
    false,
  );
  assert.equal(conflicted.mode, "degraded");
  assert.equal(conflicted.detail, "1 笔同步冲突待处理");
});
