import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";

import { credentialAad } from "./byok-envelope.js";
import type { ByokKmsContext, ByokKmsPort } from "./byok-kms.js";
import { WINDOWS_DPAPI_SCRIPT } from "./windows-dpapi-script.js";

const EXECUTABLE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const KEY_ID = "windows-dpapi-current-user";
const KEY_VERSION = "1";
const MAX_OUTPUT = 16_388;

export class WindowsDpapiError extends Error {
  constructor() {
    super("WINDOWS_DPAPI_UNAVAILABLE");
    this.name = "WindowsDpapiError";
  }
}

async function assertExecutable(): Promise<void> {
  if (process.platform !== "win32") throw new WindowsDpapiError();
  for (const path of [
    "C:\\",
    "C:\\Windows",
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\WindowsPowerShell",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    EXECUTABLE,
  ]) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (await realpath(path)).toLowerCase() !== path.toLowerCase()) {
      throw new WindowsDpapiError();
    }
  }
}

/** No shell, inherited startup hooks, plaintext arguments, or temporary key files. */
async function exchange(frame: Buffer): Promise<Buffer> {
  try {
    await assertExecutable();
  } catch {
    throw new WindowsDpapiError();
  }
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      EXECUTABLE,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_DPAPI_SCRIPT, "utf16le").toString("base64"),
      ],
      {
        windowsHide: true,
        cwd: "C:\\Windows\\System32",
        env: {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          PATH: "C:\\Windows\\System32",
          PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const output = Buffer.alloc(MAX_OUTPUT);
    let length = 0;
    let failed = false;
    const fail = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(fail, 15_000);
    child.on("error", () => {
      failed = true;
    });
    child.stdin.on("error", fail);
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (length + chunk.length > MAX_OUTPUT) {
          fail();
          return;
        }
        chunk.copy(output, length);
        length += chunk.length;
      } finally {
        chunk.fill(0);
      }
    });
    child.stderr.on("data", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        if (
          failed ||
          code !== 0 ||
          length < 20 ||
          !output.subarray(0, 4).equals(Buffer.from("LDK1"))
        ) {
          reject(new WindowsDpapiError());
        } else {
          resolve(Buffer.from(output.subarray(4, length)));
        }
      } finally {
        output.fill(0);
      }
    });
    child.stdin.end(frame);
  });
}

type DpapiExchange = (frame: Buffer) => Promise<Buffer>;

/** Injection is for the binary protocol tests; normal startup always uses the OS bridge. */
export function createWindowsDpapiKms(
  transport: DpapiExchange = exchange,
  domain: "ai" | "notification" = "ai",
): ByokKmsPort {
  const transform = async (operation: 1 | 2, data: Buffer, context: ByokKmsContext) => {
    if (
      context.envelopeSchemaVersion !== 1 ||
      data.length < 16 ||
      data.length > 16_384 ||
      (operation === 1 && data.length !== 32)
    )
      throw new WindowsDpapiError();
    const aad = credentialAad(context);
    const frame = Buffer.alloc(37 + data.length);
    frame[0] = operation;
    createHash("sha256")
      .update(`laundry:${domain}:dek:1|`, "ascii")
      .update(aad)
      .digest()
      .copy(frame, 1);
    frame.writeInt32LE(data.length, 33);
    data.copy(frame, 37);
    try {
      const result = await transport(frame);
      if (
        result.length < 16 ||
        result.length > 16_384 ||
        (operation === 2 && result.length !== 32)
      ) {
        result.fill(0);
        throw new WindowsDpapiError();
      }
      return result;
    } catch {
      throw new WindowsDpapiError();
    } finally {
      frame.fill(0);
      aad.fill(0);
    }
  };
  return Object.freeze({
    async wrapDataKey({ plaintextKey, context }) {
      return Object.freeze({
        wrappedKey: await transform(1, plaintextKey, context),
        keyId: KEY_ID,
        keyVersion: KEY_VERSION,
      });
    },
    async unwrapDataKey({ wrappedKey, keyId, keyVersion, context }) {
      if (keyId !== KEY_ID || keyVersion !== KEY_VERSION) throw new WindowsDpapiError();
      return transform(2, wrappedKey, context);
    },
  });
}
