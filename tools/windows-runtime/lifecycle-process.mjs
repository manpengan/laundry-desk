import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { cleanEnvironment } from "./lifecycle-environment.mjs";
import { fail } from "./companion-contract.mjs";

export async function run(file, args, env, cwd) {
  try {
    return (
      await promisify(execFile)(file, args, {
        env,
        cwd,
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 65536,
      })
    ).stdout.trim();
  } catch (error) {
    const code = `${error.stderr ?? ""}`.match(/\b(?:WINDOWS_COMPANION|RUNTIME)_[A-Z_]+\b/u)?.[0];
    throw new Error(code ?? "WINDOWS_COMPANION_SUBPROCESS_FAILED");
  }
}

export async function host(action, root, payload, expectedDigest) {
  const env = cleanEnvironment();
  const result = JSON.parse(
    await run(
      join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(payload, "scripts/lifecycle-host.ps1"),
        "-Action",
        action,
        "-Root",
        root,
        "-Payload",
        payload,
        "-ManifestDigest",
        expectedDigest,
      ],
      env,
      payload,
    ),
  );
  if (
    !result ||
    typeof result !== "object" ||
    (action === "ports" || action === "stop-server"
      ? Object.keys(result).sort().join(",") !== "api,postgres" ||
        typeof result.api !== "boolean" ||
        typeof result.postgres !== "boolean"
      : Object.keys(result).join(",") !== "exists" || typeof result.exists !== "boolean")
  )
    fail("HOST_RESULT_INVALID");
  return result;
}

export async function pgControl(action, root, payload, env) {
  const args = [action, `--pgdata=${join(root, "postgres-data")}`];
  if (action === "start")
    args.push(`--log=${join(root, "logs/postgres.log")}`, "--options=-h 127.0.0.1 -p 8543");
  if (action === "stop") args.push("--mode=fast");
  args.push("--wait", "--timeout=60");
  // Never pipe inherited pg_ctl output: postgres outlives its parent.
  await new Promise((resolve, reject) => {
    const child = spawn(join(payload, "postgres/bin/pg_ctl.exe"), args, {
      env,
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("WINDOWS_COMPANION_POSTGRES_TIMEOUT"));
    }, 75000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("WINDOWS_COMPANION_POSTGRES_FAILED"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("WINDOWS_COMPANION_POSTGRES_FAILED"));
    });
  });
}

export async function health(root, payload, expectedDigest) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const ports = await host("ports", root, payload, expectedDigest);
    if (ports.api && ports.postgres) {
      try {
        const response = await fetch("http://127.0.0.1:8787/health", {
          redirect: "error",
          signal: AbortSignal.timeout(2000),
        });
        const body = await response.json();
        if (response.ok && body.ok === true && body.data?.status === "ready") return;
      } catch {
        /* Bounded retry while the verified process becomes ready. */
      }
    }
    await delay(500);
  }
  fail("HEALTH_TIMEOUT");
}

export async function startServer(root, payload, env) {
  const child = spawn(
    join(payload, "node/node.exe"),
    [join(payload, "server/dist/runtime/kit-entrypoint.js"), "server"],
    { env, cwd: root, detached: true, windowsHide: true, stdio: "ignore" },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
