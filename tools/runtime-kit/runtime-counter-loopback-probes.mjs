import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { isAbsolute, join } from "node:path";

import {
  HEALTH_URL,
  POSTGRES_PORT,
  RuntimeCounterAcceptanceError,
  SERVER_PORT,
  assertSecretsNotExposed,
  assertUnavailableHealth,
  fail,
  parseReadyHealth,
} from "./runtime-counter-loopback-core.mjs";

const PROBE_TIMEOUT_MS = 2_000;
const WAIT_TIMEOUT_MS = 90_000;
const WAIT_INTERVAL_MS = 250;
const WINDOW_HEALTH_TIMEOUT_MS = 10_000;
const MAXIMUM_HEALTH_BYTES = 16_384;
const MAXIMUM_ELECTRON_OUTPUT_BYTES = 65_536;

function interrupted() {
  return new RuntimeCounterAcceptanceError("RUNTIME_COUNTER_ACCEPTANCE_INTERRUPTED");
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw interrupted();
}

function delay(duration, signal) {
  assertNotAborted(signal);
  return new Promise((resolveWait, rejectWait) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolveWait();
      else rejectWait(error);
    };
    const onAbort = () => finish(interrupted());
    const timer = setTimeout(() => finish(), duration);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function readBoundedResponse(response) {
  if (response.body === null) fail("RUNTIME_COUNTER_HEALTH_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAXIMUM_HEALTH_BYTES) {
        await reader.cancel();
        fail("RUNTIME_COUNTER_HEALTH_OUTPUT_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function healthState(signal) {
  assertNotAborted(signal);
  let response;
  try {
    const timeoutSignal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    response = await fetch(HEALTH_URL, {
      signal: signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]),
    });
  } catch {
    assertNotAborted(signal);
    return "down";
  }
  assertNotAborted(signal);
  if (response.status !== 200) return "reachable";
  try {
    parseReadyHealth(await readBoundedResponse(response));
    assertNotAborted(signal);
    return "ready";
  } catch {
    assertNotAborted(signal);
    return "reachable";
  }
}

function tcpState(port, signal) {
  assertNotAborted(signal);
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (reachable, error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error === undefined) resolveProbe(reachable);
      else rejectProbe(error);
    };
    const onAbort = () => finish(false, interrupted());
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function waitFor(label, probe, signal) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    assertNotAborted(signal);
    const matched = await probe();
    assertNotAborted(signal);
    if (matched) return;
    await delay(WAIT_INTERVAL_MS, signal);
    assertNotAborted(signal);
  }
  assertNotAborted(signal);
  fail(`RUNTIME_COUNTER_${label}_TIMEOUT`);
}

export function assertLoopbackPortAvailable(port) {
  return new Promise((resolveAvailable, rejectUnavailable) => {
    const server = createServer();
    server.once("error", () =>
      rejectUnavailable(new RuntimeCounterAcceptanceError("RUNTIME_COUNTER_FIXED_PORT_OCCUPIED")),
    );
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error === undefined) resolveAvailable();
        else {
          rejectUnavailable(
            new RuntimeCounterAcceptanceError("RUNTIME_COUNTER_PORT_PREFLIGHT_FAILED"),
          );
        }
      });
    });
  });
}

export async function assertFixedPortsAvailable() {
  await assertLoopbackPortAvailable(POSTGRES_PORT);
  await assertLoopbackPortAvailable(SERVER_PORT);
}

export async function waitForRuntimeReady(signal) {
  await waitFor("HEALTH_READY", async () => (await healthState(signal)) === "ready", signal);
  assertNotAborted(signal);
  await waitFor(
    "PORTS_READY",
    async () => {
      const [postgres, server] = await Promise.all([
        tcpState(POSTGRES_PORT, signal),
        tcpState(SERVER_PORT, signal),
      ]);
      return postgres && server;
    },
    signal,
  );
}

export async function waitForRuntimeStopped(signal) {
  await waitFor("HEALTH_DOWN", async () => (await healthState(signal)) === "down", signal);
  assertNotAborted(signal);
  await waitFor(
    "PORTS_DOWN",
    async () => {
      const [postgres, server] = await Promise.all([
        tcpState(POSTGRES_PORT, signal),
        tcpState(SERVER_PORT, signal),
      ]);
      return !postgres && !server;
    },
    signal,
  );
}

export async function assertStagedHealth(context, expectedReady) {
  let stagedUserDataRoot;
  try {
    const temporaryRoot = context.environment?.TMPDIR;
    if (
      typeof temporaryRoot !== "string" ||
      temporaryRoot.includes("\0") ||
      !isAbsolute(temporaryRoot)
    ) {
      fail("RUNTIME_COUNTER_STAGED_HEALTH_TMPDIR_INVALID");
    }
    let canonicalTemporaryRoot;
    let temporaryRootMetadata;
    try {
      [canonicalTemporaryRoot, temporaryRootMetadata] = await Promise.all([
        realpath(temporaryRoot),
        stat(temporaryRoot),
      ]);
    } catch {
      fail("RUNTIME_COUNTER_STAGED_HEALTH_TMPDIR_INVALID");
    }
    if (canonicalTemporaryRoot !== temporaryRoot || !temporaryRootMetadata.isDirectory()) {
      fail("RUNTIME_COUNTER_STAGED_HEALTH_TMPDIR_INVALID");
    }
    stagedUserDataRoot = await mkdtemp(
      join(canonicalTemporaryRoot, "laundry-runtime-staged-health-"),
    );
    await chmod(stagedUserDataRoot, 0o700);
    const result = await context.run(
      context.executable,
      [
        "--laundry-staged-health-check",
        `--user-data-dir=${stagedUserDataRoot}`,
        "--use-mock-keychain",
      ],
      {
        accepting: [0, 1],
        environment: context.environment,
        label: "RUNTIME_COUNTER_STAGED_HEALTH",
        maximumOutputBytes: MAXIMUM_ELECTRON_OUTPUT_BYTES,
        timeoutMs: 45_000,
      },
    );
    const expected = expectedReady
      ? Object.freeze({ code: 0, stdout: '{"ok":true}' })
      : Object.freeze({ code: 1, stdout: '{"ok":false}' });
    if (
      result.code !== expected.code ||
      result.stdout.trim() !== expected.stdout ||
      result.stderr !== ""
    ) {
      fail("RUNTIME_COUNTER_STAGED_HEALTH_INVALID");
    }
  } finally {
    if (stagedUserDataRoot !== undefined) {
      try {
        await rm(stagedUserDataRoot, { recursive: true });
      } catch {
        fail("RUNTIME_COUNTER_STAGED_HEALTH_CLEANUP_FAILED");
      }
    }
  }
}

export function monitorElectronOutput(application, secrets) {
  const chunks = [];
  let bytes = 0;
  let exceeded = false;
  const capture = (chunk) => {
    bytes += chunk.byteLength;
    if (bytes <= MAXIMUM_ELECTRON_OUTPUT_BYTES) chunks.push(chunk);
    else exceeded = true;
  };
  application.process().stdout?.on("data", capture);
  application.process().stderr?.on("data", capture);
  return Object.freeze({
    assertValid() {
      if (exceeded) fail("RUNTIME_COUNTER_ELECTRON_OUTPUT_TOO_LARGE");
      assertSecretsNotExposed(Buffer.concat(chunks).toString("utf8"), secrets);
    },
  });
}

export async function windowHealth(page, expectedReady, signal) {
  assertNotAborted(signal);
  const result = await new Promise((resolveHealth, rejectHealth) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolveHealth(value);
      else rejectHealth(error);
    };
    const onAbort = () => finish(undefined, interrupted());
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new RuntimeCounterAcceptanceError("RUNTIME_COUNTER_WINDOW_HEALTH_TIMEOUT"),
        ),
      WINDOW_HEALTH_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    let evaluation;
    try {
      evaluation = page.evaluate(async () => {
        const bridge = globalThis.laundryDesktop;
        if (bridge?.health?.get === undefined) return null;
        return await bridge.health.get();
      });
    } catch (error) {
      finish(undefined, error);
      return;
    }
    Promise.resolve(evaluation).then(
      (value) => finish(value),
      (error) => finish(undefined, error),
    );
  });
  assertNotAborted(signal);
  if (expectedReady) parseReadyHealth(result);
  else assertUnavailableHealth(result);
}
