import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createHttpPaymentChannelOperation } from "./payment-channel-port.js";

/** Mirrors the WebIDL receiver check of a browser's window.fetch. */
function browserLikeFetch(this: unknown): Promise<Response> {
  if (this !== undefined && this !== globalThis) {
    throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
  }
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, data: { custody_available: true, settings: [] } })),
  );
}

test("HTTP ports call an injected browser fetch without binding it to their options", async () => {
  const operation = createHttpPaymentChannelOperation({
    apiBaseUrl: "http://127.0.0.1:8787",
    fetchImpl: browserLikeFetch as typeof fetch,
    getAccessToken: () => "token",
    readCsrf: () => "csrf",
  });
  assert.deepEqual(await operation({ operation: "settings.get" }), {
    ok: true,
    data: { custody_available: true, settings: [] },
  });
});

async function compiledFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return compiledFiles(path);
      return entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") ? [path] : [];
    }),
  );
  return nested.flat();
}

test("no web module calls an injected fetch as a method", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const offenders: string[] = [];
  for (const path of await compiledFiles(root)) {
    if (/[\w$]\.fetchImpl\(/u.test(await readFile(path, "utf8"))) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});
