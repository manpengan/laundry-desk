import type { DesktopSessionView } from "@laundry/contracts";

import type { VerifiedOfflineReadAuthority } from "./read-authority.js";
import type { CacheItem, OfflineReadCache } from "./read-cache.js";

/** Coalescing window: a page's burst of queries lands in one protected write. */
export const READ_CACHE_FLUSH_DELAY_MS = 150;

export type PendingCacheWrite = Readonly<{
  session: DesktopSessionView;
  /** null = no fresh read authority; only an already usable cache state may take the entry. */
  authority: VerifiedOfflineReadAuthority | null;
  input: unknown;
  result: unknown;
  isSessionCurrent: () => boolean;
}>;

type Timers = Readonly<{
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}>;

const DEFAULT_TIMERS: Timers = Object.freeze({
  set: (run: () => void, ms: number) => setTimeout(run, ms),
  clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

function reportFailure(error: unknown): void {
  console.error("[edge-agent] offline read cache update failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

/**
 * Writes successful query results to the protected offline read cache in batches.
 *
 * Every protected write re-reads, re-verifies and atomically replaces the cache file; on
 * Windows each step runs the platform helper synchronously. One write per query made a page
 * of queries block the main process for seconds, so queries only enqueue here and one write
 * per burst carries them all. A batch keeps only entries whose session is still current at
 * write time, and discard() drops anything not yet written (logout, cache reset).
 */
export class OfflineReadCacheWriter {
  private pending: PendingCacheWrite[] = [];
  private timer: unknown = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly cache: OfflineReadCache,
    private readonly delayMs: number = READ_CACHE_FLUSH_DELAY_MS,
    private readonly timers: Timers = DEFAULT_TIMERS,
  ) {}

  enqueue(write: PendingCacheWrite): void {
    this.pending.push(write);
    if (this.timer !== null) return;
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Writes everything enqueued so far; resolves once it is on disk (or reported failed). */
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = [];
    const run = this.tail.then(() => this.write(batch));
    this.tail = run.catch(() => undefined);
    return run;
  }

  discard(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    this.pending = [];
  }

  private async write(batch: readonly PendingCacheWrite[]): Promise<void> {
    for (const group of groupBySession(batch)) {
      const current = group.filter((write) => write.isSessionCurrent());
      const last = current.at(-1);
      if (last === undefined) continue;
      const items: CacheItem[] = current.map((write) => ({
        input: write.input,
        result: write.result,
      }));
      // The newest authority binds the batch; every entry belongs to the same session.
      const authority =
        [...current].reverse().find((write) => write.authority !== null)?.authority ?? null;
      try {
        if (authority === null) await this.cache.putMany(last.session, items);
        else await this.cache.bindAndPutMany(last.session, authority, items, last.isSessionCurrent);
      } catch (error) {
        reportFailure(error);
      }
    }
  }
}

/** Consecutive writes for the same session object form one group, in arrival order. */
function groupBySession(batch: readonly PendingCacheWrite[]): PendingCacheWrite[][] {
  const groups: PendingCacheWrite[][] = [];
  for (const write of batch) {
    const group = groups.at(-1);
    if (group !== undefined && group[0]?.session === write.session) group.push(write);
    else groups.push([write]);
  }
  return groups;
}
