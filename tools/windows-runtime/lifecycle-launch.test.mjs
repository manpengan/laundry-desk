import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { digest } from "./companion-contract.mjs";
import { cleanEnvironment } from "./lifecycle-environment.mjs";

test(
  "Windows launcher returns while its detached descendant remains alive",
  {
    skip: process.platform !== "win32",
    timeout: 30000,
  },
  async (t) => {
    const payload = await mkdtemp(join(await realpath(tmpdir()), "laundry-launch-"));
    t.after(() => rm(payload, { recursive: true, force: true }));
    await mkdir(join(payload, "node"));
    await mkdir(join(payload, "scripts"));
    await copyFile(process.execPath, join(payload, "node/node.exe"));
    await copyFile(
      new URL("lifecycle-launch.ps1", import.meta.url),
      join(payload, "scripts/lifecycle-launch.ps1"),
    );
    // The descendant uses the test runner's executable, so the temporary payload
    // can be removed while it finishes its deliberately bounded lifetime.
    await writeFile(
      join(payload, "scripts/lifecycle-cli.mjs"),
      `
    import {spawn} from 'node:child_process';
    const child=spawn(${JSON.stringify(process.execPath)},['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'ignore',windowsHide:true});
    child.unref();
    console.log(JSON.stringify({pid:child.pid}));
  `,
    );
    const files = [];
    for (const path of [
      "node/node.exe",
      "scripts/lifecycle-cli.mjs",
      "scripts/lifecycle-launch.ps1",
    ]) {
      const bytes = await readFile(join(payload, path));
      files.push({ path, size: bytes.length, sha256: digest(bytes) });
    }
    const manifest = Buffer.from(JSON.stringify({ files }));
    await writeFile(join(payload, "runtime-payload.json"), manifest);
    const started = Date.now();
    const result = await promisify(execFile)(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(payload, "scripts/lifecycle-launch.ps1"),
        "-Action",
        "status",
        "-Payload",
        payload,
        "-ManifestDigest",
        digest(manifest),
      ],
      { env: cleanEnvironment(), windowsHide: true, timeout: 10000, maxBuffer: 65536 },
    );
    assert.ok(Date.now() - started < 8000, "launcher waited for inherited pipes");
    const { pid } = JSON.parse(result.stdout);
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    // A timeout can close inherited pipes after exit code 0 without rejecting
    // execFile. Require the child to still be running and the launcher below its cap.
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(result.stderr.includes("LAUNCH_OUTPUT_TIMEOUT"), false);
  },
);
