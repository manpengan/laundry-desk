import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = dirname(fileURLToPath(import.meta.url));
const builtApp = join(kitRoot, "dist/Laundry Desk Runtime Test.app");
export const signingKey = join(kitRoot, "dist/test-signing-private.pem");
const childTimeoutMs = 60_000;
const childKillGraceMs = 2_000;
const maximumChildTimeoutMs = 10 * 60_000;

const repeated = (value) => value.repeat(64);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
};

export function executeDataChild(file, args, options = {}, dependencies = {}) {
  const timeoutMs = options.timeoutMs ?? childTimeoutMs;
  const graceMs = dependencies.graceMs ?? childKillGraceMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > maximumChildTimeoutMs ||
    !Number.isSafeInteger(graceMs) ||
    graceMs <= 0 ||
    graceMs > 10_000
  ) {
    throw new Error("RUNTIME_DATA_CHILD_TIMEOUT_INVALID");
  }
  return new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = (dependencies.spawn ?? spawn)(file, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      rejectRun(new Error("RUNTIME_DATA_CHILD_START_FAILED"));
      return;
    }
    const output = [];
    const errors = [];
    let bytes = 0;
    let settled = false,
      timedOut = false,
      terminationTimer,
      finalTimer,
      timeoutTimer;
    const cleanup = () => {
      for (const timer of [timeoutTimer, terminationTimer, finalTimer]) clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.stdin.removeListener("error", onStdinError);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      error === undefined ? resolveRun(value) : rejectRun(error);
    };
    const kill = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // The bounded close fallback still settles with the fixed timeout code.
      }
    };
    const collect = (target, chunk) => {
      bytes += chunk.byteLength;
      if (bytes <= 64 * 1024) target.push(chunk);
      else kill("SIGKILL");
    };
    const onStdout = (chunk) => collect(output, chunk);
    const onStderr = (chunk) => collect(errors, chunk);
    const onStdinError = () => undefined;
    const onError = () => {
      if (!timedOut) finish(new Error("RUNTIME_DATA_CHILD_START_FAILED"));
    };
    const onClose = (code) => {
      if (timedOut) {
        finish(new Error("RUNTIME_DATA_CHILD_TIMEOUT"));
        return;
      }
      if (bytes > 64 * 1024) {
        finish(new Error("RUNTIME_DATA_OUTPUT_TOO_LARGE"));
      } else {
        finish(undefined, {
          code,
          stdout: Buffer.concat(output).toString("utf8"),
          stderr: Buffer.concat(errors).toString("utf8"),
        });
      }
    };
    child.once("error", onError);
    child.once("close", onClose);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onStdinError);
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminationTimer = setTimeout(() => {
        kill("SIGKILL");
        finalTimer = setTimeout(() => finish(new Error("RUNTIME_DATA_CHILD_TIMEOUT")), graceMs);
      }, graceMs);
      kill("SIGTERM");
    }, timeoutMs);
    child.stdin.end(options.input ?? "");
  });
}

const runChild = (executable, cwd, home, root, log, args, input, environment) =>
  executeDataChild(executable, ["--test-config-root", root, "--test-runner-log", log, ...args], {
    cwd,
    env: { PATH: "", HOME: home, ...environment },
    input,
  });

export async function createDataFixture(prefix) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), `${prefix}-`)));
  const emptyCwd = join(temporary, "empty-cwd");
  const fakeHome = join(temporary, "home");
  const copiedApp = join(temporary, "Laundry Desk Runtime Test.app");
  await Promise.all([
    mkdir(emptyCwd),
    mkdir(fakeHome),
    cp(builtApp, copiedApp, { recursive: true }),
  ]);
  const executable = join(copiedApp, "Contents/MacOS/Laundry Desk Runtime");
  const resources = join(copiedApp, "Contents/Resources");
  const [compose, lanCompose, key] = await Promise.all([
    readFile(join(resources, "docker-compose.runtime.yml")),
    readFile(join(resources, "docker-compose.runtime-lan.yml")),
    readFile(signingKey).then(createPrivateKey),
  ]);
  const payload = Object.freeze({
    schema_version: 2,
    product: "laundry-desk-runtime",
    release: "0.1.0",
    contracts_major: 2,
    contracts_sha256: repeated("a"),
    server_version: "0.1.0",
    web_bundle_sha256: repeated("b"),
    minimum_app_version: "0.1.0",
    database_schema_sha256: repeated("c"),
    migrations_sha256: repeated("d"),
    migration_head: "0033_offline_grant_replay.sql",
    maximum_compatible_schema: "0033_offline_grant_replay.sql",
    rollback_target: null,
    compose_sha256: sha256(compose),
    lan_compose_sha256: sha256(lanCompose),
    owner_spa_sha256: repeated("3"),
    server_image: Object.freeze({
      index: `registry.example/laundry/server@sha256:${repeated("e")}`,
      linux_arm64: `sha256:${repeated("f")}`,
      linux_amd64: `sha256:${repeated("1")}`,
    }),
    postgres_major: 16,
    postgres_image: `docker.io/library/postgres@sha256:${repeated("2")}`,
  });
  const signature = sign(null, Buffer.from(JSON.stringify(canonical(payload))), key).toString(
    "base64url",
  );
  const manifest = join(temporary, "runtime-manifest-v2.json");
  await writeFile(manifest, JSON.stringify({ payload, signature }), { mode: 0o600 });
  const run = (root, log, args, input = "", environment = {}) =>
    runChild(executable, emptyCwd, fakeHome, root, log, args, input, environment);
  return Object.freeze({
    temporary,
    home: fakeHome,
    manifest,
    executable,
    root: (name) => join(temporary, `root-${name}`),
    log: (name) => join(temporary, `runner-${name}.jsonl`),
    path: (name) => join(temporary, name),
    run,
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  });
}
