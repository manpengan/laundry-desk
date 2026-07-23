import assert from "node:assert/strict";
import test from "node:test";

import { createMockUsbPort } from "./usb-port.js";

const PAYLOAD = new Uint8Array([0x1b, 0x40]);

test("createMockUsbPort default succeeds", async () => {
  const port = createMockUsbPort();
  assert.equal(port.kind, "mock");
  await assert.doesNotReject(() => port.write(PAYLOAD));
});

test("createMockUsbPort failWith rejects", async () => {
  const port = createMockUsbPort({ failWith: "device busy" });
  await assert.rejects(() => port.write(PAYLOAD), /device busy/);
});

test("createMockUsbPort delay within timeout succeeds", async () => {
  const port = createMockUsbPort({ delayMs: 20 });
  await assert.doesNotReject(() => port.write(PAYLOAD, { timeoutMs: 500 }));
});

test("createMockUsbPort delay beyond timeout fails", async () => {
  const port = createMockUsbPort({ delayMs: 200 });
  await assert.rejects(
    () => port.write(PAYLOAD, { timeoutMs: 30 }),
    /USB write timed out after 30ms/,
  );
});
