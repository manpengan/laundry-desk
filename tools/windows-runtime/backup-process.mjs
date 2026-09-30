import { spawn } from "node:child_process";
import { statfs } from "node:fs/promises";
import { MAX_DUMP_BYTES } from "./backup-contract.mjs";

// Database bytes and native stderr never enter the diagnostic/output buffer.
export function streamPostgres(file, args, env, cwd, { input, output } = {}) {
  return new Promise((resolve, reject) => {
    let failure;
    let finished = false;
    let checking = false;
    const child = spawn(file, args, {
      env,
      cwd,
      windowsHide: true,
      stdio: [input?.fd ?? "ignore", output?.fd ?? "ignore", "ignore"],
    });
    function stop(code) {
      if (finished) return;
      failure ??= new Error(`WINDOWS_COMPANION_${code}`);
      child.kill();
    }
    const timeout = setTimeout(() => stop("BACKUP_PROCESS_TIMEOUT"), 600000);
    const monitor = output
      ? setInterval(async () => {
          if (checking || finished) return;
          checking = true;
          try {
            if ((await output.stat()).size > MAX_DUMP_BYTES) stop("BACKUP_DUMP_TOO_LARGE");
            const space = await statfs(cwd, { bigint: true });
            if (space.bavail * space.bsize < 128n * 1024n * 1024n)
              stop("BACKUP_SPACE_INSUFFICIENT");
          } catch {
            stop("BACKUP_PROCESS_FAILED");
          } finally {
            checking = false;
          }
        }, 250)
      : null;
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (monitor) clearInterval(monitor);
      error ? reject(error) : resolve();
    }
    child.once("error", () => finish(new Error("WINDOWS_COMPANION_BACKUP_PROCESS_FAILED")));
    child.once("close", (code) =>
      finish(failure ?? (code === 0 ? null : new Error("WINDOWS_COMPANION_BACKUP_PROCESS_FAILED"))),
    );
  });
}
