import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import { backupFixture } from "./backup-test-fixture.mjs";
import { requireAssistanceOptions, configureAssistance } from "./assistance-config.mjs";
import { readDataOptions } from "./data-options.mjs";

const config = () => ({
  trust: {
    version: 1,
    broker_url: "https://support.example/",
    broker_token: "s".repeat(32),
    issuer: "https://identity.example",
    audience: "laundry-support",
    kid: "fixture",
    public_key_spki: generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64"),
  },
});
test("assistance config has exact public HTTPS trust fields and bounded stdin", async () => {
  const options = config();
  assert.deepEqual(requireAssistanceOptions(options), options);
  assert.deepEqual(requireAssistanceOptions({ trust: null }), { trust: null });
  assert.deepEqual(
    await readDataOptions(
      "assistance-config",
      Readable.from([Buffer.from(JSON.stringify(options))]),
    ),
    options,
  );
  for (const trust of [
    { ...options.trust, command: "shell" },
    { ...options.trust, broker_url: "http://support.example/" },
    { ...options.trust, public_key_spki: "bad" },
    { ...options.trust, broker_token: "short" },
  ])
    assert.throws(() => requireAssistanceOptions({ trust }), /ARGS_INVALID/);
});
test("config replacement stops active assistance and restarts only after durable private readback", async (t) => {
  const f = await backupFixture(t),
    events = [];
  const lifecycle = {
    ...f,
    getState: () => ({ phase: "running", pending: null, current: f.entry }),
    verify: async () => ({
      manifest: { files: [{ path: "server/dist/remote-assistance/routes.js" }] },
    }),
    stop: async () => events.push("stop"),
    start: async () => events.push("start"),
  };
  const options = config();
  const result = await configureAssistance(options, lifecycle);
  assert.deepEqual(events, ["stop", "start"]);
  assert.doesNotMatch(JSON.stringify(result), /broker_token|support.example|ssss/);
  assert.deepEqual(
    JSON.parse(await f.io.read(`${f.root}/secrets/remote-assistance.json`)),
    options.trust,
  );
  await configureAssistance({ trust: null }, lifecycle);
  assert.equal(await f.io.read(`${f.root}/secrets/remote-assistance.json`), "null");
  const broken = {
    ...lifecycle,
    io: {
      ...f.io,
      write: async () => {
        throw new Error("disk-full");
      },
    },
  };
  events.length = 0;
  await assert.rejects(configureAssistance(options, broken), /disk-full/);
  assert.deepEqual(events, ["stop"]);
});
