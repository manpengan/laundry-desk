import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileUsbPort,
  createMockUsbPort,
  isPosixDevicePath,
  isWindowsDevicePath,
  normalizePrinterPath,
  resolveUsbPrintPort,
} from "./usb-port.js";

const PAYLOAD = new Uint8Array([0x1b, 0x40, 0x48, 0x69]);

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

test("createFileUsbPort writes bytes to temp file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-usb-"));
  const devicePath = join(dir, "printer.bin");
  try {
    const port = createFileUsbPort(devicePath);
    assert.equal(port.kind, "usb");
    await port.write(PAYLOAD, { timeoutMs: 2_000 });
    const written = await readFile(devicePath);
    assert.deepEqual(Uint8Array.from(written), PAYLOAD);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createFileUsbPort rejects empty path", () => {
  assert.throws(() => createFileUsbPort("  "), /non-empty devicePath/);
});

test("createFileUsbPort accepts bare COM form (normalizes for open)", () => {
  // Must not throw on construction; write may fail without hardware.
  const port = createFileUsbPort("COM3");
  assert.equal(port.kind, "usb");
});

test("normalizePrinterPath Windows COM/USB forms", () => {
  assert.equal(normalizePrinterPath("COM3"), "\\\\.\\COM3");
  assert.equal(normalizePrinterPath("\\\\.\\USB001"), "\\\\.\\USB001");
  assert.equal(isWindowsDevicePath("\\\\.\\COM3"), true);
  assert.equal(isPosixDevicePath("/dev/usb/lp0"), true);
});

test("resolveUsbPrintPort without env returns mock", () => {
  const port = resolveUsbPrintPort({});
  assert.equal(port.kind, "mock");
});

test("resolveUsbPrintPort with empty LAUNDRY_PRINTER_PATH returns mock", () => {
  const port = resolveUsbPrintPort({ LAUNDRY_PRINTER_PATH: "   " });
  assert.equal(port.kind, "mock");
});

test("resolveUsbPrintPort with LAUNDRY_PRINTER_PATH returns usb kind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-usb-env-"));
  const devicePath = join(dir, "out.bin");
  try {
    const port = resolveUsbPrintPort({ LAUNDRY_PRINTER_PATH: devicePath });
    assert.equal(port.kind, "usb");
    await port.write(PAYLOAD);
    const written = await readFile(devicePath);
    assert.deepEqual(Uint8Array.from(written), PAYLOAD);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveUsbPrintPort accepts Windows COM env form", () => {
  const port = resolveUsbPrintPort({ LAUNDRY_PRINTER_PATH: "\\\\.\\COM3" });
  assert.equal(port.kind, "usb");
});
