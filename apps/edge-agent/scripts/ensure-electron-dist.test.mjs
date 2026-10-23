import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { electronExecutable, ensureElectronDist } from "./ensure-electron-dist.mjs";

async function fakeElectron({ installed }) {
  const dir = await mkdtemp(join(tmpdir(), "electron-dist-"));
  await writeFile(join(dir, "install.js"), "");
  if (installed) {
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "path.txt"), "electron");
    await writeFile(join(dir, "dist", "electron"), "");
  }
  return dir;
}

async function installInto(dir) {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "path.txt"), "electron");
  await writeFile(join(dir, "dist", "electron"), "");
}

test("an installed binary is used as is", async () => {
  const dir = await fakeElectron({ installed: true });
  try {
    let runs = 0;
    const run = () => {
      runs += 1;
      return { status: 0 };
    };
    assert.equal(ensureElectronDist({ packageDir: dir, run }), join(dir, "dist", "electron"));
    assert.equal(runs, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing binary is fetched with the package's own installer", async () => {
  const dir = await fakeElectron({ installed: false });
  try {
    assert.equal(electronExecutable(dir), null);
    const calls = [];
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const run = (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      mkdirSync(join(dir, "dist"), { recursive: true });
      writeFileSync(join(dir, "path.txt"), "electron");
      writeFileSync(join(dir, "dist", "electron"), "");
      return { status: 0 };
    };
    assert.equal(ensureElectronDist({ packageDir: dir, run }), join(dir, "dist", "electron"));
    assert.deepEqual(calls, [
      { command: process.execPath, args: [join(dir, "install.js")], cwd: dir },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed or empty fetch stops packaging with a fixed code", async () => {
  const dir = await fakeElectron({ installed: false });
  try {
    assert.throws(
      () => ensureElectronDist({ packageDir: dir, run: () => ({ status: 1 }) }),
      /^Error: ELECTRON_DIST_UNAVAILABLE$/u,
    );
    assert.throws(
      () => ensureElectronDist({ packageDir: dir, run: () => ({ status: 0 }) }),
      /^Error: ELECTRON_DIST_UNAVAILABLE$/u,
    );
    await installInto(dir);
    assert.equal(electronExecutable(dir), join(dir, "dist", "electron"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
