import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  closeMaintenanceWindow,
  executeNative,
  powershell,
  type NativeWindow,
} from "./windows-maintenance-native.js";

test("native maintenance close waits for busy protection and rejects a different process identity", async () => {
  expect(process.platform).toBe("win32");
  const root = await mkdtemp(join(await realpath(tmpdir()), "maintenance-close-regression-"));
  const title = `Laundry maintenance fixture ${process.pid}-${Date.now()}`;
  const fixture = executeNative(
    powershell(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("windows-maintenance-fixture.ps1", import.meta.url)),
      "-EvidenceRoot",
      root,
      "-Title",
      title,
    ],
    { windowsHide: true, timeout: 60_000, maxBuffer: 8192 },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  let window: NativeWindow | undefined;
  const failures: unknown[] = [];
  try {
    await expect(async () => {
      const raw: unknown = JSON.parse(
        (await readFile(join(root, "ready.json"), "utf8")).replace(/^\uFEFF/u, ""),
      );
      expect(raw).toMatchObject({ id: expect.any(Number), started: expect.any(String) });
      window = raw as NativeWindow;
    }).toPass({ timeout: 15_000 });
    await expect(closeMaintenanceWindow({ ...window!, started: "1" }, title)).rejects.toThrow(
      "COUNTER_MAINTENANCE_WINDOW_IDENTITY_CHANGED",
    );
    const result = await closeMaintenanceWindow(window!, title, () =>
      writeFile(join(root, "release-busy"), "observed\n", { flag: "wx" }),
    );
    window = undefined;
    expect(result.observedBusy).toBe(true);
  } catch (error) {
    failures.push(error);
  } finally {
    // A failed assertion still allows the owned fixture to finish normally.
    if (window) {
      try {
        await closeMaintenanceWindow(window, title);
      } catch (error) {
        failures.push(error);
      }
    }
    const failure = await fixture;
    if (failure !== null) failures.push(failure);
    try {
      expect(
        JSON.parse((await readFile(join(root, "result.json"), "utf8")).replace(/^\uFEFF/u, "")),
      ).toEqual({
        rejected_close: 0,
        accepted_close: 1,
        expired: false,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "NATIVE_MAINTENANCE_CLOSE_REGRESSION_FAILED");
});
