import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DesktopSessionView } from "@laundry/contracts";

import type { VerifiedOfflineReadAuthority } from "./read-authority.js";
import type { CacheItem, OfflineReadCache } from "./read-cache.js";
import { OfflineReadCacheWriter, type PendingCacheWrite } from "./read-cache-writer.js";
import {
  authorityFor,
  createCache,
  orderListInput,
  orderListResult,
  safeStorage,
  sessionOf,
} from "./read-cache-fixture.js";

const now = () => new Date("2026-07-30T01:00:00.000Z");
const listInput = (status: string) => ({ name: "order.list", body: { status, limit: 20 } });

test("one protected write stores a whole batch and skips uncacheable queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-batch-"));
  let writes = 0;
  const storage = {
    ...safeStorage,
    encryptString: (value: string) => {
      writes += 1;
      return safeStorage.encryptString(value);
    },
  };
  try {
    const session = sessionOf();
    const cache = createCache(root, now, storage);
    const items: CacheItem[] = [
      { input: orderListInput, result: orderListResult },
      { input: listInput("draft"), result: orderListResult },
      { input: { name: "stats.day.summary", body: {} }, result: orderListResult },
      { input: listInput("closed"), result: orderListResult },
    ];
    const stored = await cache.bindAndPutMany(session, authorityFor(session), items, () => true);
    assert.equal(stored, 3);
    assert.equal(writes, 1);
    const reopened = createCache(root, now);
    assert.equal(reopened.resume()?.cachedQueryCount, 3);
    for (const input of [orderListInput, listInput("draft"), listInput("closed")])
      assert.deepEqual(await reopened.get(session, input), orderListResult);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a batch whose session ended before the write leaves the file untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-cache-batch-stale-"));
  let writes = 0;
  const storage = {
    ...safeStorage,
    encryptString: (value: string) => {
      writes += 1;
      return safeStorage.encryptString(value);
    },
  };
  try {
    const session = sessionOf();
    const cache = createCache(root, now, storage);
    const items = [{ input: orderListInput, result: orderListResult }];
    assert.equal(await cache.bindAndPutMany(session, authorityFor(session), items, () => false), 0);
    assert.equal(writes, 0);
    assert.equal(createCache(root, now).resume(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

type Call = Readonly<{
  kind: "bind" | "put";
  session: DesktopSessionView;
  authority: VerifiedOfflineReadAuthority | null;
  inputs: readonly unknown[];
}>;

function recordingCache(fail = false) {
  const calls: Call[] = [];
  const cache = {
    bindAndPutMany: async (
      session: DesktopSessionView,
      authority: VerifiedOfflineReadAuthority,
      items: readonly CacheItem[],
    ) => {
      if (fail) throw new Error("Synthetic persistence failure");
      calls.push({ kind: "bind", session, authority, inputs: items.map((item) => item.input) });
      return items.length;
    },
    putMany: async (session: DesktopSessionView, items: readonly CacheItem[]) => {
      calls.push({
        kind: "put",
        session,
        authority: null,
        inputs: items.map((item) => item.input),
      });
      return items.length;
    },
  } as unknown as OfflineReadCache;
  return { cache, calls };
}

function manualTimers() {
  const scheduled: Array<() => void> = [];
  return {
    scheduled,
    timers: {
      set: (run: () => void) => {
        scheduled.push(run);
        return scheduled.length;
      },
      clear: () => undefined,
    },
  };
}

function write(
  session: DesktopSessionView,
  input: unknown,
  authority: VerifiedOfflineReadAuthority | null,
  isSessionCurrent = () => true,
): PendingCacheWrite {
  return { session, authority, input, result: orderListResult, isSessionCurrent };
}

test("a burst of queries becomes one write bound by the newest authority", async () => {
  const { cache, calls } = recordingCache();
  const { scheduled, timers } = manualTimers();
  const writer = new OfflineReadCacheWriter(cache, 150, timers);
  const session = sessionOf();
  const older = authorityFor(session);
  const newer = authorityFor(session, "2026-07-30T00:30:00.000Z");
  writer.enqueue(write(session, listInput("open"), older));
  writer.enqueue(write(session, listInput("draft"), null));
  writer.enqueue(write(session, listInput("closed"), newer));
  assert.equal(scheduled.length, 1, "one timer per burst");
  scheduled[0]?.();
  await writer.flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.kind, "bind");
  assert.equal(calls[0]?.authority, newer);
  assert.deepEqual(calls[0]?.inputs, [listInput("open"), listInput("draft"), listInput("closed")]);
});

test("entries of an ended session are dropped and discard() forgets unwritten ones", async () => {
  const { cache, calls } = recordingCache();
  const writer = new OfflineReadCacheWriter(cache, 150, manualTimers().timers);
  const session = sessionOf();
  let current = true;
  writer.enqueue(write(session, listInput("open"), null, () => current));
  current = false;
  await writer.flush();
  assert.deepEqual(calls, [], "a session that ended before the write persists nothing");

  writer.enqueue(write(session, listInput("open"), authorityFor(session)));
  writer.discard();
  await writer.flush();
  assert.deepEqual(calls, [], "logout discards results that were not written yet");
});

test("each session keeps its own write, in arrival order, without authority writes put", async () => {
  const { cache, calls } = recordingCache();
  const writer = new OfflineReadCacheWriter(cache, 150, manualTimers().timers);
  const first = sessionOf();
  const second = sessionOf({ staff_id: "51a2eed0-a6c3-493c-a3a7-20bf94b1d678" });
  writer.enqueue(write(first, listInput("open"), null));
  writer.enqueue(write(second, listInput("draft"), authorityFor(second)));
  await writer.flush();
  assert.deepEqual(
    calls.map((call) => [call.kind, call.session, call.inputs.length]),
    [
      ["put", first, 1],
      ["bind", second, 1],
    ],
  );
});

test("a failed write is reported and never rejects the flush", async (t) => {
  const { cache } = recordingCache(true);
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const writer = new OfflineReadCacheWriter(cache, 150, manualTimers().timers);
  const session = sessionOf();
  writer.enqueue(write(session, listInput("open"), authorityFor(session)));
  await writer.flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.[0], "[edge-agent] offline read cache update failed");
});
