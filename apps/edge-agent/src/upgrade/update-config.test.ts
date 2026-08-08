import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  developmentUpdateConfiguration,
  loadBundledUpdateConfiguration,
  parseUpdateConfiguration,
  resolveUpdateConfiguration,
} from "./update-config.js";

const enabled = Object.freeze({
  schema_version: 1 as const,
  enabled: true as const,
  channel: "stable" as const,
  manifest_url: "https://updates.example/laundry/stable/latest-laundry-v2.json",
});

test("strict update configuration accepts only direct credential-free HTTPS", () => {
  assert.deepEqual(parseUpdateConfiguration(enabled), enabled);
  for (const manifest_url of [
    "http://updates.example/latest.json",
    "https://user:pass@updates.example/latest.json",
    "https://updates.example/latest.json?channel=stable",
    "https://updates.example/latest.json#fragment",
    "https://updates.example/latest",
  ]) {
    assert.throws(() => parseUpdateConfiguration({ ...enabled, manifest_url }));
  }
  assert.throws(() => parseUpdateConfiguration({ ...enabled, unexpected: true }));
  assert.throws(() =>
    parseUpdateConfiguration({ schema_version: 1, enabled: false, channel: "stable" }),
  );
});

test("packaged configuration comes only from its bundle, never the Finder environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-config-"));
  t.after(async () => rm(root, { recursive: true }));
  const updateRoot = join(root, "update");
  await mkdir(updateRoot);
  await writeFile(join(updateRoot, "update-config.json"), JSON.stringify(enabled));
  const resolved = await resolveUpdateConfiguration({
    isPackaged: true,
    resourcesPath: root,
    env: {
      LAUNDRY_UPDATE_MANIFEST_URL: "https://attacker.example/ignored.json",
      LAUNDRY_DEV_UPDATE_MANIFEST_URL: "https://attacker.example/also-ignored.json",
      LAUNDRY_DEV_UPDATE_CHANNEL: "beta",
    },
  });
  assert.deepEqual(resolved, enabled);
});

test("development update input is namespaced and opt-in", () => {
  assert.deepEqual(developmentUpdateConfiguration({}), { schema_version: 1, enabled: false });
  assert.deepEqual(
    developmentUpdateConfiguration({
      LAUNDRY_DEV_UPDATE_MANIFEST_URL: enabled.manifest_url,
      LAUNDRY_DEV_UPDATE_CHANNEL: enabled.channel,
      LAUNDRY_UPDATE_MANIFEST_URL: "https://ignored.example/latest.json",
    }),
    enabled,
  );
  assert.throws(() =>
    developmentUpdateConfiguration({ LAUNDRY_DEV_UPDATE_MANIFEST_URL: enabled.manifest_url }),
  );
});

test("bundle loader rejects symlinks and malformed JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-config-file-"));
  t.after(async () => rm(root, { recursive: true }));
  const outside = join(root, "outside.json");
  const linked = join(root, "linked.json");
  await writeFile(outside, JSON.stringify(enabled));
  await symlink(outside, linked);
  await assert.rejects(() => loadBundledUpdateConfiguration(linked), /bounded real file/u);
  const malformed = join(root, "malformed.json");
  await writeFile(malformed, "{");
  await assert.rejects(() => loadBundledUpdateConfiguration(malformed), /valid JSON/u);
});
