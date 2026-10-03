import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { canonicalManifest, digest } from "./companion-contract.mjs";
import { inventory } from "./companion-files.mjs";
import { cleanEnvironment } from "./lifecycle-environment.mjs";
import { packageRuntimeEntry } from "./package-runtime-entry.mjs";
import { runtimeEntryFixture } from "./runtime-entry-test-fixture.mjs";

const windowsOnly = { skip: process.platform !== "win32", timeout: 45000 };

async function inputFixture(t) {
  const fixture = await runtimeEntryFixture(t);
  await copyFile(process.execPath, join(fixture.payload, "node/node.exe"));
  for (const name of ["lifecycle-launch.ps1", "lifecycle-native.ps1"])
    await copyFile(new URL(name, import.meta.url), join(fixture.payload, "scripts", name));
  await writeFile(
    join(fixture.payload, "scripts/lifecycle-cli.mjs"),
    `import { createHash } from 'node:crypto';
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
console.log(JSON.stringify({ assurance: 'development_only',
  sha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex') }));
`,
  );
  const files = (await inventory(fixture.payload, ["runtime-payload.json"])).files;
  const manifest = { ...fixture.manifest, files };
  const bytes = canonicalManifest(manifest);
  await writeFile(join(fixture.payload, "runtime-payload.json"), bytes);
  const current = { ...fixture, manifest, manifestSha: digest(bytes) };
  await packageRuntimeEntry(current);
  return current;
}

async function runInput(fixture, bytes, { codePage = 437, close = true } = {}) {
  const entry = join(fixture.output, "runtime-entry.ps1").replaceAll("'", "''");
  const command = `[Console]::InputEncoding=[Text.Encoding]::GetEncoding(${codePage}); & '${entry}' -Action portable-inspect`;
  const child = spawn(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(command, "utf16le").toString("base64"),
    ],
    { env: cleanEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    const stdout = [],
      stderr = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("test input deadline exceeded"));
    }, 30000);
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > 65536) {
        child.kill();
        reject(new Error("test output limit exceeded"));
      } else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.stdin.on("error", (error) => {
      // Rejection tests intentionally close before all input is consumed.
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") reject(error);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (close) child.stdin.end(bytes);
    else child.stdin.write(bytes);
  });
}

test(
  "WinPS entry preserves UTF-8 Chinese paths and passwords under CP936 and CP437",
  windowsOnly,
  async (t) => {
    const fixture = await inputFixture(t);
    const input = Buffer.from(
      JSON.stringify({ path: "C:\\验收副本\\洗衣.ldbackup", password: "合成测试口令-不得外发" }),
    );
    for (const codePage of [936, 437]) {
      const result = await runInput(fixture, input, { codePage });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).sha256, digest(input));
      assert.equal(result.stdout.includes("口令"), false);
    }
  },
);

test(
  "WinPS entry rejects oversized and invalid UTF-8 stdin before the data launcher",
  windowsOnly,
  async (t) => {
    const fixture = await inputFixture(t);
    for (const [input, expected] of [
      [Buffer.alloc(8193, 65), "WINDOWS_RUNTIME_ENTRY_ARGS_INVALID"],
      [Buffer.from([0xff, 0xc0, 0xaf]), "WINDOWS_RUNTIME_ENTRY_INPUT_INVALID"],
    ]) {
      const result = await runInput(fixture, input);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout.trim(), "");
      assert.equal(result.stderr.trim(), expected);
    }
  },
);

test("WinPS entry times out partial JSON without waiting for stdin EOF", windowsOnly, async (t) => {
  const fixture = await inputFixture(t);
  const started = Date.now();
  const result = await runInput(fixture, Buffer.from('{"password":"synthetic'), { close: false });
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout.trim(), "");
  assert.equal(result.stderr.trim(), "WINDOWS_RUNTIME_ENTRY_INPUT_TIMEOUT");
  assert.ok(Date.now() - started < 25000);
});

test("entry input boundary uses raw bounded bytes without a console-codepage decoder", async () => {
  const [entry, trust] = await Promise.all([
    readFile(new URL("runtime-entry.ps1", import.meta.url), "utf8"),
    readFile(new URL("runtime-entry-trust.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(entry, /ReadProtocolInput\(\)/u);
  assert.doesNotMatch(entry, /Console\]::In\.ReadBlock/u);
  assert.match(trust, /new UTF8Encoding\(false, true\)\.GetString/u);
});
