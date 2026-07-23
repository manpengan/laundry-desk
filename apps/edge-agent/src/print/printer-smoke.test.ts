import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPrinterSmokePayload,
  runPrinterSmoke,
  type PrinterSmokeResult,
} from "./printer-smoke.js";

function assertShape(result: PrinterSmokeResult): void {
  assert.equal(typeof result.ok, "boolean");
  assert.ok(result.path === null || typeof result.path === "string");
  assert.ok(["mock", "usb", "missing"].includes(result.kind));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
}

test("buildPrinterSmokePayload is non-empty ESC/POS init+cut", () => {
  const bytes = buildPrinterSmokePayload();
  assert.ok(bytes.byteLength > 0);
  // ESC @
  assert.equal(bytes[0], 0x1b);
  assert.equal(bytes[1], 0x40);
  // GS V somewhere near end (partial cut)
  const asArray = Array.from(bytes);
  const gs = asArray.lastIndexOf(0x1d);
  assert.ok(gs >= 0);
  assert.equal(asArray[gs + 1], 0x56);
});

test("runPrinterSmoke without LAUNDRY_PRINTER_PATH is mock ok", async () => {
  const result = await runPrinterSmoke({});
  assertShape(result);
  assert.equal(result.ok, true);
  assert.equal(result.kind, "mock");
  assert.equal(result.path, null);
  assert.match(result.message, /LAUNDRY_PRINTER_PATH/);
  assert.equal(result.bytes_written, undefined);
});

test("runPrinterSmoke with empty LAUNDRY_PRINTER_PATH is mock ok", async () => {
  const result = await runPrinterSmoke({ LAUNDRY_PRINTER_PATH: "   " });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "mock");
  assert.equal(result.path, null);
});

test("runPrinterSmoke with file path writes ESC/POS bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-"));
  const devicePath = join(dir, "spool.bin");
  try {
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: devicePath },
      { timeoutMs: 2_000 },
    );
    assertShape(result);
    assert.equal(result.ok, true);
    assert.equal(result.kind, "usb");
    assert.equal(result.path, devicePath);
    assert.ok(typeof result.bytes_written === "number" && result.bytes_written > 0);

    const written = await readFile(devicePath);
    assert.equal(written.byteLength, result.bytes_written);
    assert.equal(written[0], 0x1b);
    assert.equal(written[1], 0x40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPrinterSmoke honors custom payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-custom-"));
  const devicePath = join(dir, "out.bin");
  const payload = new Uint8Array([0x1b, 0x40, 0x41]);
  try {
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: devicePath },
      { payload, timeoutMs: 2_000 },
    );
    assert.equal(result.ok, true);
    assert.equal(result.bytes_written, 3);
    const written = await readFile(devicePath);
    assert.deepEqual(Uint8Array.from(written), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPrinterSmoke missing path returns kind missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-miss-"));
  const missing = join(dir, "no-such-subdir", "printer.bin");
  try {
    const result = await runPrinterSmoke({ LAUNDRY_PRINTER_PATH: missing }, { timeoutMs: 1_000 });
    assertShape(result);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "missing");
    assert.equal(result.path, missing);
    assert.match(result.message, /ENOENT|no such file/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPrinterSmoke write to directory fails with kind usb", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-dir-"));
  try {
    const result = await runPrinterSmoke({ LAUNDRY_PRINTER_PATH: dir }, { timeoutMs: 1_000 });
    assertShape(result);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "usb");
    assert.equal(result.path, dir);
    assert.ok(result.message.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPrinterSmoke with short timeout still settles (no hang)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-to-"));
  const devicePath = join(dir, "fast.bin");
  const started = Date.now();
  try {
    const result = await runPrinterSmoke({ LAUNDRY_PRINTER_PATH: devicePath }, { timeoutMs: 500 });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.equal(result.kind, "usb");
    assert.ok(elapsed < 2_000, `elapsed ${elapsed}ms should stay under 2s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
