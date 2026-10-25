import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
const execute = promisify(execFile);

function publicTiming(line) {
  if (!line.startsWith("WINDOWS_COMPANION_TIMING ")) return null;
  try {
    const value = JSON.parse(line.slice("WINDOWS_COMPANION_TIMING ".length));
    if (
      Object.keys(value).sort().join() !== "elapsed_ms,executable" ||
      typeof value.executable !== "string" ||
      !/^(?:node|powershell|initdb|createdb|pg_ctl|pg_dump|pg_restore|psql|postgres)\.exe$/iu.test(
        value.executable,
      ) ||
      !Number.isSafeInteger(value.elapsed_ms) ||
      value.elapsed_ms < 0 ||
      value.elapsed_ms > 600000
    )
      return null;
    return `WINDOWS_COMPANION_TIMING ${JSON.stringify({ executable: value.executable, elapsed_ms: value.elapsed_ms })}`;
  } catch {
    return null;
  }
}

function requirePrivateOutput(output, secrets) {
  if (secrets.some((value) => output.includes(value)))
    throw new Error("WINDOWS_COMPANION_STORE_ACCEPTANCE_SECRET_OUTPUT");
}

function publicDiagnostic(line) {
  const prefix = "WINDOWS_COMPANION_DIAGNOSTIC ";
  if (!line.startsWith(prefix) || line.length > 2048) return null;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value).sort().join();
    const native = keys === "code,frames";
    if (!native && keys !== "cause_code,code,frames,message_code") return null;
    const code = (item) =>
      item === null || (typeof item === "string" && /^[A-Z][A-Z0-9_]{1,80}$/u.test(item));
    if (
      native
        ? typeof value.code !== "string" || !/^[A-Za-z0-9_.,-]{1,120}$/u.test(value.code)
        : ![value.code, value.cause_code, value.message_code].every(code)
    )
      return null;
    const frame = native
      ? /^lifecycle-host\.ps1:\d{1,6}$/u
      : /^lifecycle(?:-[a-z]+)?\.mjs:\d{1,6}:\d{1,6}$/u;
    if (
      !Array.isArray(value.frames) ||
      value.frames.length > 5 ||
      !value.frames.every((item) => typeof item === "string" && frame.test(item))
    )
      return null;
    return `${prefix}${JSON.stringify(
      native
        ? { code: value.code, frames: value.frames }
        : {
            code: value.code,
            cause_code: value.cause_code,
            message_code: value.message_code,
            frames: value.frames,
          },
    )}`;
  } catch {
    return null;
  }
}

// Keep only the producer's public codes/relative frames; never attach the raw exec error.
export function storeAcceptanceFailure(error, secrets = []) {
  const message = typeof error?.message === "string" ? error.message : "";
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  requirePrivateOutput(`${message}\n${stdout}\n${stderr}`, secrets);
  const stable = /^WINDOWS_COMPANION_[A-Z_]{1,100}$/u;
  const lines = stderr.length <= 65536 ? stderr.split("\n").map((line) => line.trim()) : [];
  const code = stable.test(message) ? message : lines.find((line) => stable.test(line));
  const failure = new Error(code ?? "WINDOWS_COMPANION_STORE_ACCEPTANCE_FAILED");
  const diagnostics = lines
    .map(publicDiagnostic)
    .filter((line) => line !== null)
    .slice(0, 8);
  failure.stderr = [...diagnostics, failure.message].join("\n");
  requirePrivateOutput(failure.stderr, secrets);
  return failure;
}

// CI harness only; not part of the distributed payload.
export function launchCommander({ payload, expectedDigest, env }, dependencies = {}) {
  const launch = dependencies.execute ?? execute;
  const log = dependencies.log ?? console.log;
  async function command(action, source = payload, hash = expectedDigest, options = {}) {
    const inputProtocol = [
      "install-store",
      "portable-export",
      "portable-inspect",
      "portable-import",
      "v1-import",
      "export-store",
      "backup-schedule",
    ].includes(action);
    const secrets =
      action === "install-store"
        ? [options.admin, options.approver]
            .flatMap((person) => Object.values(person ?? {}))
            .filter((value) => typeof value === "string" && value.length > 0)
        : [];
    const started = Date.now();
    const pending = launch(
      join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(source, "scripts/lifecycle-launch.ps1"),
        "-Action",
        action,
        "-Payload",
        source,
        "-ManifestDigest",
        hash,
        ...(options.backupId ? ["-BackupId", options.backupId] : []),
        ...(!inputProtocol && options.confirmation
          ? ["-ConfirmationDigest", options.confirmation]
          : []),
      ],
      {
        env: {
          ...env,
          NODE_OPTIONS: "--require=C:/laundry-injection-must-not-load.cjs",
          NODE_PATH: "C:/laundry-injection",
          DATABASE_URL: "forbidden",
          PGHOST: "forbidden",
          LAUNDRY_PUBLIC_ORIGIN: "forbidden",
        },
        cwd: payload,
        windowsHide: true,
        timeout: 600000,
        maxBuffer: 65536,
      },
    );
    const input = inputProtocol ? Buffer.from(JSON.stringify(options), "utf8") : null;
    let inputFailed = false;
    pending.child.stdin.on("error", () => {
      inputFailed = true;
    });
    pending.child.stdin.end(input ?? undefined);
    let timingBuffer = "";
    pending.child.stderr.on("data", (chunk) => {
      timingBuffer += chunk;
      const lines = timingBuffer.split("\n");
      timingBuffer = lines.pop();
      for (const line of lines) {
        const record = publicTiming(line.trim());
        if (record && !secrets.some((value) => record.includes(value))) log(record);
      }
    });
    try {
      const result = await pending;
      requirePrivateOutput(`${result.stdout}\n${result.stderr ?? ""}`, secrets);
      if (inputFailed) throw new Error("WINDOWS_COMPANION_ACCEPTANCE_INPUT_FAILED");
      return JSON.parse(result.stdout);
    } catch (error) {
      requirePrivateOutput(
        `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`,
        secrets,
      );
      throw error;
    } finally {
      input?.fill(0);
      log(JSON.stringify({ action, event: "launcher-close", elapsed_ms: Date.now() - started }));
    }
  }
  return command;
}
