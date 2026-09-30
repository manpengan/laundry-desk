import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
const execute = promisify(execFile);

// CI harness only; not part of the distributed payload.
export function launchCommander({ payload, expectedDigest, env }) {
  async function command(action, source = payload, hash = expectedDigest, options = {}) {
    const started = Date.now();
    const pending = execute(
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
        ...(options.confirmation ? ["-ConfirmationDigest", options.confirmation] : []),
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
    let timingBuffer = "";
    pending.child.stderr.on("data", (chunk) => {
      timingBuffer += chunk;
      const lines = timingBuffer.split("\n");
      timingBuffer = lines.pop();
      for (const line of lines) {
        if (/^WINDOWS_COMPANION_TIMING \{[A-Za-z0-9_\s"{},.:[\]\-]*\}$/u.test(line.trim()))
          console.log(line.trim());
      }
    });
    try {
      const result = await pending;
      return JSON.parse(result.stdout);
    } finally {
      console.log(
        JSON.stringify({ action, event: "launcher-close", elapsed_ms: Date.now() - started }),
      );
    }
  }
  return command;
}
