import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { inspectPrivateDirectory, inspectPrivateFile } from "@laundry/platform-fs";
import { z } from "zod";
import {
  boundEntryTrust,
  boundRuntimeResult,
  createControllerGate,
} from "./windows-offline-bindings.mjs";
import { boundedController } from "./windows-offline-controller.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const SOURCE = /^[a-f0-9]{40}$/u;
const ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "USERNAME",
  "USERDOMAIN",
]);
const Health = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ status: z.literal("ready") }),
});

export function acceptanceEnvironment(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      ENVIRONMENT_KEYS.flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value] as const];
      }),
    ),
  );
}

export function absoluteInput(name: string): string {
  const value = process.env[name];
  if (
    value === undefined ||
    value !== value.trim() ||
    !isAbsolute(value) ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("WINDOWS_OFFLINE_PATH_INVALID");
  }
  return resolve(value);
}

export async function installedExecutable(): Promise<string> {
  const path = absoluteInput("LAUNDRY_WINDOWS_INSTALLED_EXE");
  try {
    await canonicalPath(path);
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > 536_870_912) {
      throw new Error("INVALID");
    }
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      unchanged(before, await handle.stat());
      unchanged(before, await lstat(path));
    } finally {
      await handle.close();
    }
    return path;
  } catch {
    throw new Error("WINDOWS_OFFLINE_EXECUTABLE_INVALID");
  }
}

function hashInput(name: string, pattern = HASH): string {
  const value = process.env[name];
  if (value === undefined || !pattern.test(value))
    throw new Error("WINDOWS_OFFLINE_BINDING_INVALID");
  return value;
}

async function canonicalPath(path: string): Promise<void> {
  for (let current = path; ; current = dirname(current)) {
    const metadata = await lstat(current);
    if (
      metadata.isSymbolicLink() ||
      (await realpath(current)).toLowerCase() !== resolve(current).toLowerCase()
    ) {
      throw new Error("WINDOWS_OFFLINE_PATH_INVALID");
    }
    if (dirname(current) === current) return;
  }
}

function unchanged(before: Stats, after: Stats): void {
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new Error("WINDOWS_OFFLINE_FILE_CHANGED");
  }
}

async function boundedFile(path: string, maximum: number, privateFile = false): Promise<Buffer> {
  await canonicalPath(path);
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > maximum
  ) {
    throw new Error("WINDOWS_OFFLINE_FILE_INVALID");
  }
  if (privateFile) await inspectPrivateFile(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    unchanged(before, await handle.stat());
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    unchanged(before, await handle.stat());
    unchanged(before, await lstat(path));
    await canonicalPath(path);
    if (length !== before.size) throw new Error("WINDOWS_OFFLINE_FILE_CHANGED");
    if (privateFile) await inspectPrivateFile(path);
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("WINDOWS_OFFLINE_JSON_INVALID");
  }
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function boundedPowerShell(script: string): Promise<string> {
  const powershell = join(
    absoluteInput("SystemRoot"),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  await canonicalPath(powershell);
  return await boundedController(script, powershell, acceptanceEnvironment());
}

export async function bindOfflineRuntime() {
  try {
    if (process.platform !== "win32") throw new Error("WINDOWS_OFFLINE_PLATFORM_INVALID");
    const entry = absoluteInput("LAUNDRY_WINDOWS_OFFLINE_ENTRY");
    const entrySha = hashInput("LAUNDRY_WINDOWS_OFFLINE_ENTRY_SHA256");
    const source = hashInput("LAUNDRY_WINDOWS_OFFLINE_SOURCE_SHA", SOURCE);
    const manifest = hashInput("LAUNDRY_WINDOWS_OFFLINE_MANIFEST_SHA256");
    const parent = join(absoluteInput("LOCALAPPDATA"), "Programs", "Laundry Desk Runtime V2");
    const expected = join(parent, manifest, "runtime-entry.ps1");
    if (entry.toLowerCase() !== expected.toLowerCase())
      throw new Error("WINDOWS_OFFLINE_BINDING_INVALID");
    const bytes = await boundedFile(entry, 262_144);
    // Reuse only the SHA-bound entry's native no-follow trust implementation; no new C# interop.
    const trust = boundEntryTrust(bytes, entrySha);
    const action = async (verb: "status" | "start" | "stop") => {
      const script = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
${trust}
$held=$null; $child=$null; $started=$false; $confirmed=$false; $failed=$false; $text=$null
try {
  [void][LaundryRuntimeEntryTrust]::HoldDirectoryPath(${quote(dirname(entry))})
  [LaundryRuntimeEntryTrust]::AssertPrivateDirectory(${quote(parent)})
  [LaundryRuntimeEntryTrust]::AssertPrivateDirectory(${quote(dirname(entry))})
  $held=[LaundryRuntimeEntryTrust]::OpenVerified(${quote(entry)},${bytes.length},${quote(entrySha)})
  $child=New-Object Diagnostics.Process
  $child.StartInfo.FileName=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  $child.StartInfo.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ${quote(entry)} + '" -Action ${verb}'
  $child.StartInfo.UseShellExecute=$false; $child.StartInfo.CreateNoWindow=$true
  $child.StartInfo.RedirectStandardOutput=$true; $child.StartInfo.RedirectStandardError=$true
  if(-not $child.Start()){throw 'FAILED'}
  $started=$true
  $out=[LaundryRuntimeEntryTrust]::ReadBounded($child.StandardOutput)
  $err=[LaundryRuntimeEntryTrust]::ReadBounded($child.StandardError)
  $deadline=[DateTime]::UtcNow.AddSeconds(1020)
  while(-not $child.HasExited -or -not $out.IsCompleted -or -not $err.IsCompleted){
    [Threading.Thread]::Sleep(100)
    if($out.IsFaulted -or $err.IsFaulted -or [DateTime]::UtcNow -gt $deadline){throw 'FAILED'}
  }
  if(-not $child.WaitForExit(5000)){throw 'FAILED'}
  $confirmed=$true
  if($child.ExitCode -ne 0 -or $err.Result.Length -ne 0){throw 'FAILED'}
  $text=$out.Result.Trim()
} catch { $failed=$true }
finally {
  try {
    if($null -ne $child){
      try {
        if($started -and -not $confirmed){
          if(-not $child.HasExited){$child.Kill()}
          if(-not $child.WaitForExit(5000)){throw 'UNCONFIRMED'}
          $confirmed=$true
        }
      } catch {$failed=$true}
      finally {$child.Dispose()}
    }
  }
  finally {if($null -ne $held){$held.Dispose()}; [LaundryRuntimeEntryTrust]::ReleaseDirectories()}
}
if($failed -or -not $confirmed){[Console]::Error.WriteLine('WINDOWS_OFFLINE_CONTROLLER_UNCONFIRMED'); exit 1}
[Console]::Out.WriteLine($text)`;
      const output = await boundedPowerShell(script);
      return boundRuntimeResult(output, verb, source, manifest);
    };
    const controller = createControllerGate(action);
    await controller.action("status");
    return controller;
  } catch (error) {
    if (error instanceof Error && error.message === "WINDOWS_OFFLINE_CONTROLLER_UNCONFIRMED") {
      throw new Error("WINDOWS_OFFLINE_CONTROLLER_UNCONFIRMED");
    }
    throw new Error("WINDOWS_OFFLINE_RUNTIME_PREFLIGHT_FAILED");
  }
}

export async function waitForRuntimeHealth(expected: "ready" | "down"): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8787/health", {
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("WINDOWS_OFFLINE_HEALTH_INVALID");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 4096) throw new Error("WINDOWS_OFFLINE_HEALTH_INVALID");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      if (
        expected === "ready" &&
        response.status === 200 &&
        Health.safeParse(parseJson(Buffer.concat(chunks))).success
      )
        return;
    } catch (error) {
      // Only a transport connection refusal establishes down; reachable/erroring APIs do not.
      if (
        expected === "down" &&
        error instanceof TypeError &&
        "cause" in error &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "code" in error.cause &&
        error.cause.code === "ECONNREFUSED"
      )
        return;
    }
    await delay(250);
  }
  throw new Error("WINDOWS_OFFLINE_HEALTH_TIMEOUT");
}

const QueueFile = z.strictObject({
  version: z.literal(1),
  rows: z
    .array(
      z.strictObject({
        id: z.uuid(),
        seq: z.number().int().positive(),
        sealed_payload: z.base64(),
        aad: z.string().min(1).max(512),
        state: z.literal("pending"),
      }),
    )
    .length(1),
});
const KeyFile = z.strictObject({
  version: z.literal(1),
  protected_kek: z.base64(),
  wrapped_dek: z.strictObject({
    key_version: z.number().int().positive(),
    algorithm: z.literal("AES-256-GCM"),
    nonce: z.base64(),
    ciphertext: z.base64(),
    auth_tag: z.base64(),
  }),
});

export async function sealedQueueSnapshot(userData: string, markers: readonly string[]) {
  let queue: Buffer | null = null;
  let key: Buffer | null = null;
  let sealed: Buffer | null = null;
  let complete = false;
  try {
    const root = join(userData, "edge-state");
    await canonicalPath(root);
    await inspectPrivateDirectory(root);
    queue = await boundedFile(join(root, "offline-queue.json"), 1_048_576, true);
    key = await boundedFile(join(root, "queue-key.json"), 65_536, true);
    const parsedQueue = QueueFile.safeParse(parseJson(queue));
    const parsedKey = KeyFile.safeParse(parseJson(key));
    if (!parsedQueue.success || !parsedKey.success) throw new Error("INVALID");
    sealed = Buffer.from(parsedQueue.data.rows[0]!.sealed_payload, "base64");
    const buffers = Object.freeze([queue, key, sealed]);
    const wrapped = parsedKey.data.wrapped_dek;
    if (
      sealed.length < 28 ||
      Buffer.from(parsedKey.data.protected_kek, "base64").length < 16 ||
      Buffer.from(wrapped.nonce, "base64").length !== 12 ||
      Buffer.from(wrapped.ciphertext, "base64").length !== 32 ||
      Buffer.from(wrapped.auth_tag, "base64").length !== 16 ||
      markers.some((marker) => buffers.some((bytes) => bytes.includes(Buffer.from(marker))))
    ) {
      throw new Error("INVALID");
    }
    complete = true;
    return Object.freeze({ queue, key });
  } catch {
    throw new Error("WINDOWS_OFFLINE_SEALED_QUEUE_INVALID");
  } finally {
    sealed?.fill(0);
    if (!complete) {
      queue?.fill(0);
      key?.fill(0);
    }
  }
}
