import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAXIMUM_OUTPUT_BYTES = 16 * 1024;
const MAXIMUM_STDIN_BYTES = 1024 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
const DEFAULT_HELPER_PATH = fileURLToPath(
  new URL("../native/windows/laundry-windows-helper.exe", import.meta.url),
);
const HELPER_FILE_NAME = "laundry-windows-helper.exe";
const SHA256 = /^[0-9a-f]{64}$/u;
let configuredHelperDirectory: string | null = null;

export type WindowsHelperResult = Readonly<Record<string, unknown>>;

export class WindowsHelperSubmissionError extends Error {
  constructor(readonly outcome: "failed" | "uncertain") {
    super(
      outcome === "uncertain"
        ? "WINDOWS_HELPER_SUBMISSION_UNCERTAIN"
        : "WINDOWS_HELPER_SUBMISSION_FAILED",
    );
    this.name = "WindowsHelperSubmissionError";
  }
}

type WindowsHelperPaths = Readonly<{ helper: string; digest: string }>;

function windowsHelperPaths(): WindowsHelperPaths {
  const helper =
    configuredHelperDirectory === null
      ? DEFAULT_HELPER_PATH
      : join(configuredHelperDirectory, HELPER_FILE_NAME);
  return Object.freeze({ helper, digest: `${helper}.sha256` });
}

/** Fixes packaged Windows helper lookup to the application's immutable resources directory. */
export function configureWindowsHelperDirectory(directory: string): void {
  if (!isAbsolute(directory) || directory.includes("\0")) {
    throw new Error("WINDOWS_HELPER_DIRECTORY_INVALID");
  }
  const candidate = resolvePath(directory);
  if (configuredHelperDirectory !== null && configuredHelperDirectory !== candidate) {
    throw new Error("WINDOWS_HELPER_DIRECTORY_ALREADY_CONFIGURED");
  }
  configuredHelperDirectory = candidate;
}

function assertAbsoluteArguments(arguments_: readonly string[]): void {
  for (const argument of arguments_.slice(1)) {
    if (argument.includes("\\") || argument.includes("/")) {
      if (!isAbsolute(argument)) throw new Error("WINDOWS_HELPER_ARGUMENT_INVALID");
    }
  }
}

function parseResult(stdout: string): WindowsHelperResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("WINDOWS_HELPER_OUTPUT_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("WINDOWS_HELPER_OUTPUT_INVALID");
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true) throw new Error("WINDOWS_HELPER_OUTPUT_INVALID");
  return Object.freeze({ ...result });
}

function expectedDigest(bytes: Buffer): string {
  const value = bytes.toString("ascii").trim();
  if (!SHA256.test(value)) throw new Error("WINDOWS_HELPER_DIGEST_INVALID");
  return value;
}

async function assertRegularUniqueFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("WINDOWS_HELPER_FILE_INVALID");
  }
}

function assertRegularUniqueFileSync(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error("WINDOWS_HELPER_FILE_INVALID");
  }
}

async function assertHelperIntegrity(paths: WindowsHelperPaths): Promise<void> {
  await Promise.all([assertRegularUniqueFile(paths.helper), assertRegularUniqueFile(paths.digest)]);
  const [helper, digest] = await Promise.all([readFile(paths.helper), readFile(paths.digest)]);
  if (createHash("sha256").update(helper).digest("hex") !== expectedDigest(digest)) {
    throw new Error("WINDOWS_HELPER_INTEGRITY_FAILED");
  }
}

function assertHelperIntegritySync(paths: WindowsHelperPaths): void {
  assertRegularUniqueFileSync(paths.helper);
  assertRegularUniqueFileSync(paths.digest);
  const helper = readFileSync(paths.helper);
  const digest = readFileSync(paths.digest);
  if (createHash("sha256").update(helper).digest("hex") !== expectedDigest(digest)) {
    throw new Error("WINDOWS_HELPER_INTEGRITY_FAILED");
  }
}

export async function runWindowsHelper(
  arguments_: readonly string[],
): Promise<WindowsHelperResult> {
  assertAbsoluteArguments(arguments_);
  const paths = windowsHelperPaths();
  await assertHelperIntegrity(paths);
  try {
    const { stdout } = await execFileAsync(paths.helper, [...arguments_], {
      encoding: "utf8",
      maxBuffer: MAXIMUM_OUTPUT_BYTES,
      timeout: HELPER_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseResult(stdout);
  } catch (error) {
    throw new Error("WINDOWS_HELPER_EXECUTION_FAILED", { cause: error });
  }
}

export function runWindowsHelperSync(arguments_: readonly string[]): WindowsHelperResult {
  assertAbsoluteArguments(arguments_);
  const paths = windowsHelperPaths();
  assertHelperIntegritySync(paths);
  try {
    const stdout = execFileSync(paths.helper, [...arguments_], {
      encoding: "utf8",
      maxBuffer: MAXIMUM_OUTPUT_BYTES,
      timeout: HELPER_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseResult(stdout);
  } catch (error) {
    throw new Error("WINDOWS_HELPER_EXECUTION_FAILED", { cause: error });
  }
}

export async function runWindowsHelperWithInput(
  arguments_: readonly string[],
  input: Uint8Array,
): Promise<WindowsHelperResult> {
  if (input.byteLength < 1 || input.byteLength > MAXIMUM_STDIN_BYTES) {
    throw new Error("WINDOWS_HELPER_INPUT_INVALID");
  }
  assertAbsoluteArguments(arguments_);
  const paths = windowsHelperPaths();
  await assertHelperIntegrity(paths);
  return await new Promise<WindowsHelperResult>((resolve, reject) => {
    const child = spawn(paths.helper, [...arguments_], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else {
        try {
          resolve(parseResult(stdout.toString("utf8")));
        } catch {
          reject(new WindowsHelperSubmissionError("uncertain"));
        }
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new WindowsHelperSubmissionError("uncertain"));
    }, HELPER_TIMEOUT_MS);
    child.once("error", () => finish(new WindowsHelperSubmissionError("failed")));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAXIMUM_OUTPUT_BYTES) {
        child.kill();
        finish(new WindowsHelperSubmissionError("uncertain"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAXIMUM_OUTPUT_BYTES) {
        child.kill();
        finish(new WindowsHelperSubmissionError("uncertain"));
      }
    });
    child.once("exit", (code) => {
      if (code === 0 && stderrBytes === 0) finish();
      else finish(new WindowsHelperSubmissionError(code === 2 ? "uncertain" : "failed"));
    });
    child.stdin.once("error", () => finish(new WindowsHelperSubmissionError("uncertain")));
    child.stdin.end(Buffer.from(input));
  });
}
