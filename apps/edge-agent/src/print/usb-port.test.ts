import assert from "node:assert/strict";
import { constants } from "node:fs";
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
  validatePrinterDevicePath,
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

test("timed-out device work quarantines later writes until the original settles", async () => {
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  let laterWrites = 0;
  const first = createFileUsbPort("/tmp/injected-stalled-device", {
    writeBytes: async () => stalled,
  });
  const later = createFileUsbPort("/tmp/injected-later-device", {
    writeBytes: async () => {
      laterWrites += 1;
    },
  });

  await assert.rejects(() => first.write(PAYLOAD, { timeoutMs: 10 }), /timed out/i);
  await assert.rejects(() => later.write(PAYLOAD), /previous timed-out printer write/i);
  assert.equal(laterWrites, 0);

  release();
  await stalled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.doesNotReject(() => later.write(PAYLOAD));
  assert.equal(laterWrites, 1);
});

test("normalizePrinterPath Windows COM/USB forms", () => {
  assert.equal(normalizePrinterPath("COM3"), "\\\\.\\COM3");
  assert.equal(normalizePrinterPath("\\\\.\\USB001"), "\\\\.\\USB001");
  assert.equal(isWindowsDevicePath("\\\\.\\COM3"), true);
  assert.equal(isPosixDevicePath("/dev/usb/lp0"), true);
});

test("Windows accepts only COM/LPT/USB printer endpoint names", () => {
  const dependencies = {
    platform: "win32" as const,
    stat: (): never => {
      throw new Error("Windows endpoint validation must not stat a filesystem path");
    },
  };

  const accepted = new Map([
    ["COM3", "\\\\.\\COM3"],
    ["LPT1", "\\\\.\\LPT1"],
    ["USB001", "\\\\.\\USB001"],
    ["\\\\.\\com12", "\\\\.\\COM12"],
    ["\\\\.\\lpt1", "\\\\.\\LPT1"],
    ["\\\\.\\usb001", "\\\\.\\USB001"],
  ]);
  for (const [configured, expected] of accepted) {
    assert.equal(validatePrinterDevicePath(configured, dependencies), expected);
  }

  for (const rejected of [
    "C:\\temp\\x",
    "relative-printer.bin",
    "..\\printer.bin",
    "\\\\.\\PhysicalDrive0",
    "\\\\server\\printer",
    "/dev/usb/lp0",
  ]) {
    assert.throws(
      () => validatePrinterDevicePath(rejected, dependencies),
      /COM|LPT|USB|Windows printer/i,
      rejected,
    );
  }
});

test("POSIX accepts only real, non-symlink character devices under /dev", () => {
  const inspected: string[] = [];
  const characterDevice = {
    platform: "linux" as const,
    stat: (path: string) => {
      inspected.push(path);
      return {
        isCharacterDevice: () => true,
        isSymbolicLink: () => false,
      };
    },
  };

  assert.equal(validatePrinterDevicePath("/dev/usb/lp0", characterDevice), "/dev/usb/lp0");
  assert.deepEqual(inspected, ["/dev/usb/lp0"]);

  assert.throws(
    () =>
      validatePrinterDevicePath("/dev/usb/lp0", {
        platform: "linux",
        stat: () => ({ isCharacterDevice: () => false }),
      }),
    /character device/i,
  );
  assert.throws(
    () =>
      validatePrinterDevicePath("/dev/serial/by-id/printer", {
        platform: "linux",
        stat: () => ({
          isCharacterDevice: () => false,
          isSymbolicLink: () => true,
        }),
      }),
    /character device|symlink/i,
  );

  for (const rejected of [
    "/tmp/x",
    "/dev/../tmp/x",
    "/dev/usb/../usb/lp0",
    "relative.bin",
    "COM3",
  ]) {
    assert.throws(
      () => validatePrinterDevicePath(rejected, characterDevice),
      /under \/dev|POSIX printer|traversal/i,
      rejected,
    );
  }
  assert.deepEqual(inspected, ["/dev/usb/lp0"], "outside paths must be rejected before stat");
});

test("resolveUsbPrintPort without env returns mock", () => {
  const port = resolveUsbPrintPort({});
  assert.equal(port.kind, "mock");
});

test("resolveUsbPrintPort with empty LAUNDRY_PRINTER_PATH returns mock", () => {
  const port = resolveUsbPrintPort({ LAUNDRY_PRINTER_PATH: "   " });
  assert.equal(port.kind, "mock");
});

test("resolveUsbPrintPort rejects arbitrary spool paths from product env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "laundry-usb-env-"));
  const devicePath = join(dir, "out.bin");
  try {
    assert.throws(
      () => resolveUsbPrintPort({ LAUNDRY_PRINTER_PATH: devicePath }),
      /under \/dev|POSIX printer/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveUsbPrintPort accepts Windows COM env form", () => {
  const port = resolveUsbPrintPort({ LAUNDRY_PRINTER_PATH: "\\\\.\\COM3" }, { platform: "win32" });
  assert.equal(port.kind, "usb");
});

test("resolveUsbPrintPort accepts a validated POSIX character device", () => {
  const port = resolveUsbPrintPort(
    { LAUNDRY_PRINTER_PATH: "/dev/usb/lp0" },
    {
      platform: "linux",
      stat: () => ({ isCharacterDevice: () => true, isSymbolicLink: () => false }),
    },
  );
  assert.equal(port.kind, "usb");
});

test("product port rejects a POSIX target replaced after validation", async () => {
  let validationCalls = 0;
  let writes = 0;
  let closed = false;
  let openedFlags: string | number | undefined;
  const port = resolveUsbPrintPort(
    { LAUNDRY_PRINTER_PATH: "/dev/usb/lp0" },
    {
      platform: "linux",
      stat: () => {
        validationCalls += 1;
        return { isCharacterDevice: () => true, isSymbolicLink: () => false };
      },
      openDevice: async (_path, flags) => {
        openedFlags = flags;
        return {
          stat: async () => ({ isCharacterDevice: () => false }),
          write: async () => {
            writes += 1;
          },
          close: async () => {
            closed = true;
          },
        };
      },
    },
  );

  await assert.rejects(() => port.write(PAYLOAD), /opened POSIX printer target.*character device/i);
  assert.equal(validationCalls, 2, "path must be revalidated immediately before open");
  assert.equal(writes, 0);
  assert.equal(closed, true);
  assert.equal(typeof openedFlags, "number");
  assert.notEqual((openedFlags as number) & constants.O_NOFOLLOW, 0);
});
