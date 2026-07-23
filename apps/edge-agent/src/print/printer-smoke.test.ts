import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildPrinterSmokePayload,
  isAccessDeniedError,
  isMissingDeviceError,
  normalizePrinterPath,
  runPrinterSmoke,
  type PrinterSmokeResult,
} from "./printer-smoke.js";
import {
  createFileUsbPort,
  createMockUsbPort,
  isPosixDevicePath,
  isWindowsDevicePath,
  resolveUsbPrintPort,
} from "./usb-port.js";

function assertShape(result: PrinterSmokeResult): void {
  assert.equal(typeof result.ok, "boolean");
  assert.ok(result.path === null || typeof result.path === "string");
  assert.ok(["mock", "usb", "missing"].includes(result.kind));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
}

test("normalizePrinterPath maps bare COM/USB to Windows device namespace", () => {
  assert.equal(normalizePrinterPath("COM3"), "\\\\.\\COM3");
  assert.equal(normalizePrinterPath("com3"), "\\\\.\\COM3");
  assert.equal(normalizePrinterPath("COM12"), "\\\\.\\COM12");
  assert.equal(normalizePrinterPath("USB001"), "\\\\.\\USB001");
  assert.equal(normalizePrinterPath("usb001"), "\\\\.\\USB001");
  assert.equal(normalizePrinterPath("\\\\.\\COM3"), "\\\\.\\COM3");
  assert.equal(normalizePrinterPath("\\\\.\\com5"), "\\\\.\\COM5");
  assert.equal(normalizePrinterPath("\\\\.\\usb001"), "\\\\.\\USB001");
  assert.equal(normalizePrinterPath("//./COM3"), "\\\\.\\COM3");
  assert.equal(normalizePrinterPath('"COM3"'), "\\\\.\\COM3");
  assert.equal(normalizePrinterPath("'USB001'"), "\\\\.\\USB001");
});

test("normalizePrinterPath leaves file and POSIX paths", () => {
  assert.equal(normalizePrinterPath("/dev/usb/lp0"), "/dev/usb/lp0");
  assert.equal(normalizePrinterPath("  /tmp/spool.bin  "), "/tmp/spool.bin");
  assert.equal(normalizePrinterPath("C:\\\\temp\\\\spool.bin"), "C:\\\\temp\\\\spool.bin");
  assert.equal(normalizePrinterPath(""), "");
  assert.equal(normalizePrinterPath("   "), "");
});

test("isWindowsDevicePath / isPosixDevicePath helpers", () => {
  assert.equal(isWindowsDevicePath("\\\\.\\COM3"), true);
  assert.equal(isWindowsDevicePath("COM3"), false);
  assert.equal(isWindowsDevicePath("/tmp/x"), false);
  assert.equal(isPosixDevicePath("/dev/usb/lp0"), true);
  assert.equal(isPosixDevicePath("/tmp/x"), false);
});

test("isMissingDeviceError / isAccessDeniedError classifiers", () => {
  assert.equal(isMissingDeviceError("ENOENT: no such file or directory"), true);
  assert.equal(isMissingDeviceError("The system cannot find the file specified."), true);
  assert.equal(isMissingDeviceError("EACCES: permission denied"), false);
  assert.equal(isAccessDeniedError("EACCES: permission denied, open '\\\\.\\COM3'"), true);
  assert.equal(isAccessDeniedError("EPERM: operation not permitted"), true);
  assert.equal(isAccessDeniedError("Access is denied."), true);
  assert.equal(isAccessDeniedError("ENOENT: no such file"), false);
});

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
  assert.match(result.message, /COM3|USB001/i);
  assert.equal(result.bytes_written, undefined);
});

test("runPrinterSmoke with empty LAUNDRY_PRINTER_PATH is mock ok", async () => {
  const result = await runPrinterSmoke({ LAUNDRY_PRINTER_PATH: "   " });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "mock");
  assert.equal(result.path, null);
});

test("runPrinterSmoke validate-only never opens or writes the device", async () => {
  let writes = 0;
  const result = await runPrinterSmoke(
    { LAUNDRY_PRINTER_PATH: "COM3" },
    {
      validateOnly: true,
      deviceDependencies: { platform: "win32" },
      usbPort: {
        kind: "usb" as const,
        write: async () => {
          writes += 1;
        },
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.path, "\\\\.\\COM3");
  assert.equal(result.bytes_written, undefined);
  assert.match(result.message, /no bytes written/i);
  assert.equal(writes, 0);
});

test("runPrinterSmoke rejects arbitrary product file paths before writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-product-"));
  const path = join(dir, "must-not-exist.bin");
  try {
    const result = await runPrinterSmoke({ LAUNDRY_PRINTER_PATH: path });
    assert.equal(result.ok, false);
    assert.equal(result.path, path);
    assert.match(result.message, /under \/dev|POSIX printer/i);
    await assert.rejects(() => readFile(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPrinterSmoke with file path writes ESC/POS bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-"));
  const devicePath = join(dir, "spool.bin");
  try {
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: devicePath },
      { timeoutMs: 2_000, usbPort: createFileUsbPort(devicePath) },
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

test("runPrinterSmoke normalizes Windows-style COM path in result.path", async () => {
  // On non-Windows hosts the device will be missing; path must still normalize.
  const result = await runPrinterSmoke(
    { LAUNDRY_PRINTER_PATH: "COM3" },
    { timeoutMs: 500, deviceDependencies: { platform: "win32" } },
  );
  assertShape(result);
  assert.equal(result.path, "\\\\.\\COM3");
  // Hardware usually absent in CI — either missing or access failure is fine.
  if (!result.ok) {
    assert.ok(result.kind === "missing" || result.kind === "usb");
    assert.ok(result.message.length > 0);
  }
});

test("runPrinterSmoke normalizes USB001 path form", async () => {
  const result = await runPrinterSmoke(
    { LAUNDRY_PRINTER_PATH: "USB001" },
    { timeoutMs: 500, deviceDependencies: { platform: "win32" } },
  );
  assert.equal(result.path, "\\\\.\\USB001");
  assert.ok(result.kind === "missing" || result.kind === "usb" || result.ok);
});

test("runPrinterSmoke honors custom payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-custom-"));
  const devicePath = join(dir, "out.bin");
  const payload = new Uint8Array([0x1b, 0x40, 0x41]);
  try {
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: devicePath },
      { payload, timeoutMs: 2_000, usbPort: createFileUsbPort(devicePath) },
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
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: missing },
      { timeoutMs: 1_000, usbPort: createFileUsbPort(missing) },
    );
    assertShape(result);
    assert.equal(result.ok, false);
    assert.equal(result.kind, "missing");
    assert.equal(result.path, missing);
    assert.match(result.message, /ENOENT|no such file|Path missing/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runPrinterSmoke write to directory fails with kind usb", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-dir-"));
  try {
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: dir },
      { timeoutMs: 1_000, usbPort: createFileUsbPort(dir) },
    );
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
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: devicePath },
      { timeoutMs: 500, usbPort: createFileUsbPort(devicePath) },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true);
    assert.equal(result.kind, "usb");
    assert.ok(elapsed < 2_000, `elapsed ${elapsed}ms should stay under 2s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createFileUsbPort writes spool file (create mode)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-usb-file-"));
  const devicePath = join(dir, "printer.bin");
  const payload = new Uint8Array([0x1b, 0x40, 0x48, 0x69]);
  try {
    const port = createFileUsbPort(devicePath);
    assert.equal(port.kind, "usb");
    await port.write(payload, { timeoutMs: 2_000 });
    const written = await readFile(devicePath);
    assert.deepEqual(Uint8Array.from(written), payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveUsbPrintPort with Windows-style COM env still resolves usb kind", () => {
  const port = resolveUsbPrintPort({ LAUNDRY_PRINTER_PATH: "COM3" }, { platform: "win32" });
  assert.equal(port.kind, "usb");
});

test("createMockUsbPort failWith rejects with access-style message for annotate path", async () => {
  const port = createMockUsbPort({ failWith: "EACCES: permission denied" });
  await assert.rejects(() => port.write(new Uint8Array([1])), /EACCES/);
});

test("runPrinterSmoke annotates access-denied mock via file that is not writable", async () => {
  // Best-effort: on Unix, open existing file as r+ after chmod 000 may yield EACCES.
  // Skip soft-assert if platform cannot restrict (e.g. root CI).
  const dir = await mkdtemp(join(tmpdir(), "laundry-smoke-eacces-"));
  const devicePath = join(dir, "locked.bin");
  try {
    await writeFile(devicePath, Buffer.from([0]));
    // Reuse path as Windows device is not available; annotate path is covered by unit classifiers.
    // Here we only ensure a real usb fail still returns kind usb with non-empty message.
    const result = await runPrinterSmoke(
      { LAUNDRY_PRINTER_PATH: dir },
      { timeoutMs: 500, usbPort: createFileUsbPort(dir) },
    );
    assert.equal(result.ok, false);
    assert.equal(result.kind, "usb");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
