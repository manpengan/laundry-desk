import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createIsolatedPgTestDatabase } from "./isolated-pg-test-database.js";
import { resolvePgUrls } from "./pg-pool.js";

/** Reproduce a slow socket shutdown without changing pool.end() semantics. */
class SlowClosingClient extends pg.Client {
  override end(): Promise<void>;
  override end(callback: (error: Error) => void): void;
  override end(callback?: (error: Error) => void): Promise<void> | void {
    if (callback !== undefined) {
      setTimeout(() => super.end(callback), 150);
      return;
    }
    return new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void super.end().then(resolve, reject);
      }, 150);
    });
  }
}

const urls = resolvePgUrls();
test(
  "isolated PG cleanup waits for idle socket shutdown after pool.end resolves",
  {
    skip: urls === null,
  },
  async (t) => {
    assert.ok(urls);
    const fixture = await createIsolatedPgTestDatabase(urls);
    t.after(fixture.close);
    const pool = new pg.Pool({ connectionString: fixture.urls.app, Client: SlowClosingClient });
    const idleErrors: unknown[] = [];
    // Captured errors are asserted below, never ignored as successful cleanup.
    pool.on("error", (error: unknown) => idleErrors.push(error));
    let ended = false;
    try {
      const client = await pool.connect();
      await client.query("SELECT 1");
      const disconnected = new Promise<void>((resolve) => {
        client.once("end", () => {
          ended = true;
          resolve();
        });
      });
      client.release();
      await pool.end();
      assert.equal(ended, false, "fixture must exercise a still-closing socket");
      await fixture.close();
      await disconnected;
      assert.deepEqual(idleErrors, [], "cleanup must not terminate an idle application client");
      assert.equal(ended, true);
    } finally {
      if (!pool.ending) await pool.end();
    }
  },
);
