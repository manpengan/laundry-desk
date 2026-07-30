import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signReleaseManifest } from "./release-manifest.js";
import { createRuntimeUpdateIo, type UpdateFetch } from "./runtime-io.js";

const keys = generateKeyPairSync("ed25519");
const ARTIFACT = Buffer.from("verified-artifact", "utf8");
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");

function signedManifest() {
  return signReleaseManifest(
    {
      protocol_version: 1,
      channel: "stable",
      version: "0.2.0",
      minimum_secure_version: "0.1.0",
      minimum_upgradable_version: "0.0.1",
      contracts_major: 0,
      local_schema: 3,
      published_at: "2026-07-30T01:02:03.000Z",
      artifacts: [
        {
          kind: "zip",
          name: "laundry-desk-0.2.0-mac.zip",
          size_bytes: ARTIFACT.byteLength,
          sha256: DIGEST,
        },
      ],
      rollback: null,
    },
    keys.privateKey,
  );
}

test("fetches a direct HTTPS manifest and streams its exact signed artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-io-"));
  try {
    const seen: string[] = [];
    const fetchImpl: UpdateFetch = async (url) => {
      seen.push(url);
      return new Response(url.endsWith(".json") ? JSON.stringify(signedManifest()) : ARTIFACT, {
        status: 200,
      });
    };
    const io = createRuntimeUpdateIo(fetchImpl);
    const manifestUrl = "https://updates.example.test/stable/latest.json";
    const candidate = await io.fetchManifest(manifestUrl);
    const downloaded = await io.downloadArtifact(
      manifestUrl,
      candidate.authority,
      "laundry-desk-0.2.0-mac.zip",
      root,
    );
    assert.deepEqual(seen, [
      manifestUrl,
      "https://updates.example.test/stable/laundry-desk-0.2.0-mac.zip",
    ]);
    assert.deepEqual(await readFile(downloaded.path), ARTIFACT);
    assert.equal(downloaded.sha256, DIGEST);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("digest mismatch fails closed and removes the partial artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-io-"));
  try {
    const io = createRuntimeUpdateIo(async () => new Response(Buffer.alloc(ARTIFACT.length, 7)));
    const authority = signedManifest().authority;
    await assert.rejects(
      io.downloadArtifact(
        "https://updates.example.test/stable/latest.json",
        authority,
        authority.artifacts[0]!.name,
        root,
      ),
      /signed size and digest/u,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-HTTPS, credentials, query strings, and redirect responses", async () => {
  const io = createRuntimeUpdateIo(async () => new Response("{}", { status: 302 }));
  await assert.rejects(io.fetchManifest("http://updates.example.test/latest.json"), /HTTPS/u);
  await assert.rejects(
    io.fetchManifest("https://user:secret@updates.example.test/latest.json"),
    /credential-free/u,
  );
  await assert.rejects(
    io.fetchManifest("https://updates.example.test/latest.json?channel=stable"),
    /fixed/u,
  );
  await assert.rejects(
    io.fetchManifest("https://updates.example.test/latest.json"),
    /direct successful/u,
  );
});
