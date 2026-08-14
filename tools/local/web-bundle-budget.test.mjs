import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectWebBundle, WEB_BUNDLE_BUDGETS } from "./web-bundle-budget.mjs";

async function withBundle(files, html, run) {
  const root = await mkdtemp(join(tmpdir(), "laundry-web-bundle-"));
  try {
    const assets = join(root, "assets");
    await mkdir(assets);
    for (const [name, value] of Object.entries(files)) {
      await writeFile(join(assets, name), value);
    }
    await writeFile(join(root, "index.html"), html);
    await run(root, assets);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const entryHtml = (extra = "") => `<script type="module" src="./assets/entry.js"></script>${extra}`;

test("accepts bounded chunks and reports initial, total JS, and CSS bytes", async () => {
  await withBundle(
    { "entry.js": "entry", "route.js": "route", "app.css": "css" },
    entryHtml(),
    async (root) => {
      assert.deepEqual(await inspectWebBundle(root), {
        chunkCount: 2,
        largestChunkBytes: 5,
        initialJsBytes: 5,
        totalJsBytes: 10,
        totalCssBytes: 3,
      });
    },
  );
});

test("rejects one JavaScript chunk over the hard 500 KiB budget", async () => {
  await withBundle(
    { "entry.js": "x".repeat(WEB_BUNDLE_BUDGETS.maxChunkBytes + 1) },
    entryHtml(),
    async (root) => {
      await assert.rejects(inspectWebBundle(root), {
        code: "WEB_BUNDLE_CHUNK_BUDGET_EXCEEDED",
      });
    },
  );
});

test("rejects an eager entry plus preloads over the initial JS budget", async () => {
  const half = Math.floor(WEB_BUNDLE_BUDGETS.maxInitialJsBytes / 2) + 1;
  await withBundle(
    { "entry.js": "x".repeat(half), "shared.js": "y".repeat(half) },
    entryHtml('<link rel="modulepreload" href="./assets/shared.js">'),
    async (root) => {
      await assert.rejects(inspectWebBundle(root), {
        code: "WEB_BUNDLE_INITIAL_JS_BUDGET_EXCEEDED",
      });
    },
  );
});

test("rejects aggregate lazy JavaScript growth even when each chunk is bounded", async () => {
  const chunk = "x".repeat(Math.floor(WEB_BUNDLE_BUDGETS.maxChunkBytes * 0.8));
  await withBundle(
    {
      "entry.js": "entry",
      "route-a.js": chunk,
      "route-b.js": chunk,
      "route-c.js": chunk,
      "route-d.js": chunk,
    },
    entryHtml(),
    async (root) => {
      await assert.rejects(inspectWebBundle(root), {
        code: "WEB_BUNDLE_TOTAL_JS_BUDGET_EXCEEDED",
      });
    },
  );
});

test("rejects missing initial assets and symlinked bundle assets", async () => {
  await withBundle({ "route.js": "route" }, entryHtml(), async (root) => {
    await assert.rejects(inspectWebBundle(root), { code: "WEB_BUNDLE_INITIAL_ASSET_MISSING" });
  });
  await withBundle({ "entry.js": "entry" }, entryHtml(), async (root, assets) => {
    await symlink(join(assets, "entry.js"), join(assets, "linked.js"));
    await assert.rejects(inspectWebBundle(root), { code: "WEB_BUNDLE_ASSET_INVALID" });
  });
});
