import assert from "node:assert/strict";
import { createPublicKey, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const API = "http://127.0.0.1:8787";
const BROWSER_HEADERS = Object.freeze({
  origin: "http://127.0.0.1:5173",
  "sec-fetch-site": "same-site",
});
const DESKTOP_HEADERS = Object.freeze({
  origin: API,
  "sec-fetch-site": "same-origin",
});
const QUEUE = "Acceptance_XP58";
const REQUIRED_ENV = Object.freeze([
  "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
  "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
]);

export class PrintDispatchAcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "PrintDispatchAcceptanceError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new PrintDispatchAcceptanceError(code);
};

export function requiredEnvironment(env) {
  const values = Object.fromEntries(
    REQUIRED_ENV.map((name) => {
      const value = env[name];
      if (typeof value !== "string" || value.length === 0) fail("PRINT_ACCEPTANCE_ENV_INVALID");
      return [name, value];
    }),
  );
  return Object.freeze(values);
}

export function validateCapturedEscPos(bytes) {
  const payload = Buffer.from(bytes);
  if (
    payload.byteLength < 64 ||
    payload[0] !== 0x1b ||
    payload[1] !== 0x40 ||
    (!payload.includes(Buffer.from([0x1d, 0x56, 0x00])) &&
      !payload.includes(Buffer.from([0x1d, 0x56, 0x01])))
  ) {
    fail("PRINT_ACCEPTANCE_ESC_POS_INVALID");
  }
}

function cookiesFrom(response) {
  const lines = response.headers.getSetCookie?.() ?? [];
  const entries = lines.flatMap((line) => {
    const pair = line.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    return separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
  });
  const cookies = Object.fromEntries(entries);
  const csrf = cookies.laundry_csrf ?? cookies["__Host-laundry_csrf"];
  if (typeof csrf !== "string" || csrf.length === 0) fail("PRINT_ACCEPTANCE_LOGIN_FAILED");
  return Object.freeze({
    csrf,
    header: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
  });
}

async function parseOk(response, code) {
  let body;
  try {
    body = await response.json();
  } catch {
    fail(code);
  }
  if (!response.ok || body?.ok !== true) fail(code);
  return body.data;
}

async function login(env, deviceId) {
  const credentials = requiredEnvironment(env);
  const response = await fetch(`${API}/api/v2/auth/login`, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      org_code: "local",
      store_code: "main",
      username: credentials.LAUNDRY_BOOTSTRAP_ADMIN_USERNAME,
      password: credentials.LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD,
      device_id: deviceId,
    }),
  });
  const cookies = cookiesFrom(response);
  const data = await parseOk(response, "PRINT_ACCEPTANCE_LOGIN_FAILED");
  if (typeof data?.access_token !== "string" || typeof data?.session?.staff_id !== "string") {
    fail("PRINT_ACCEPTANCE_LOGIN_FAILED");
  }
  return Object.freeze({ token: data.access_token, staffId: data.session.staff_id, cookies });
}

function protectedHeaders(auth, surface) {
  return Object.freeze({
    ...(surface === "desktop" ? DESKTOP_HEADERS : BROWSER_HEADERS),
    "content-type": "application/json",
    authorization: `Bearer ${auth.token}`,
    cookie: auth.cookies.header,
    "x-csrf-token": auth.cookies.csrf,
  });
}

async function protectedPost(auth, path, body, code, surface = "browser") {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: protectedHeaders(auth, surface),
    body: JSON.stringify(body),
  });
  return parseOk(response, code);
}

async function pairDevice(auth, deviceId, material, createSignedAuthorityRequest) {
  const requestNonce = randomUUID();
  const publicKey = material.exportPublic().publicKeySpkiBase64Url;
  const challenge = await protectedPost(
    auth,
    "/api/v2/edge/authority/challenge",
    {
      request_nonce: requestNonce,
      device_public_key_spki: publicKey,
      request_primary: false,
    },
    "PRINT_ACCEPTANCE_PAIRING_FAILED",
    "desktop",
  );
  const signer = Object.freeze({
    publicKeySpkiBase64Url: publicKey,
    signBytes: (message) => material.signBytes(message),
  });
  const proof = createSignedAuthorityRequest(deviceId, challenge, signer, requestNonce, false);
  const authority = await protectedPost(
    auth,
    "/api/v2/edge/authority",
    proof,
    "PRINT_ACCEPTANCE_PAIRING_FAILED",
    "desktop",
  );
  if (typeof authority?.server_public_key_spki !== "string") {
    fail("PRINT_ACCEPTANCE_PAIRING_FAILED");
  }
  return createPublicKey({
    key: Buffer.from(authority.server_public_key_spki, "base64url"),
    format: "der",
    type: "spki",
  });
}

async function firstOrderId(auth) {
  const data = await protectedPost(
    auth,
    "/v1/queries/order.list",
    { limit: 1 },
    "PRINT_ACCEPTANCE_ORDER_UNAVAILABLE",
  );
  const orderId = data?.result?.orders?.[0]?.order_id;
  if (typeof orderId !== "string") fail("PRINT_ACCEPTANCE_ORDER_UNAVAILABLE");
  return orderId;
}

async function enqueue(auth, orderId) {
  const data = await protectedPost(
    auth,
    "/v1/commands/print.ticket.enqueue",
    { order_id: orderId, kind: "xp58" },
    "PRINT_ACCEPTANCE_ENQUEUE_FAILED",
  );
  const jobId = data?.result?.job_id;
  if (typeof jobId !== "string") fail("PRINT_ACCEPTANCE_ENQUEUE_FAILED");
  return jobId;
}

async function claim(auth, expectedJobId) {
  const requestStartedWallMs = Date.now();
  const requestStartedMonoMs = performance.now();
  const data = await protectedPost(
    auth,
    "/api/v2/edge/print/claim",
    { supported_printer_kinds: ["xp58"] },
    "PRINT_ACCEPTANCE_CLAIM_FAILED",
    "desktop",
  );
  const responseReceivedMonoMs = performance.now();
  if (data?.capability_ticket?.payload?.job_id !== expectedJobId) {
    fail("PRINT_ACCEPTANCE_CLAIM_MISMATCH");
  }
  return Object.freeze({
    dispatch: data,
    timing: Object.freeze({ requestStartedWallMs, requestStartedMonoMs, responseReceivedMonoMs }),
  });
}

async function settle(auth, ledger, execution, expectedStatus, expectedResult) {
  const settlement = await protectedPost(
    auth,
    "/api/v2/edge/print/receipt",
    { receipt: execution.receipt },
    "PRINT_ACCEPTANCE_RECEIPT_FAILED",
    "desktop",
  );
  if (settlement?.status !== expectedStatus || settlement?.result !== expectedResult) {
    fail("PRINT_ACCEPTANCE_SETTLEMENT_MISMATCH");
  }
  await ledger.markUploaded(execution.jobId, execution.receipt);
}

async function createFakeLp(root) {
  const executable = join(root, "fake-lp.mjs");
  const source = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const invocation = process.env.LAUNDRY_ACCEPTANCE_LP_INVOCATIONS;
const capture = process.env.LAUNDRY_ACCEPTANCE_LP_CAPTURE;
if (!invocation || !capture) process.exit(64);
appendFileSync(invocation, (process.env.LAUNDRY_ACCEPTANCE_LP_MODE || "success") + "\\n", { mode: 0o600 });
if (process.env.LAUNDRY_ACCEPTANCE_LP_MODE === "hang") {
  process.stdin.resume();
  setInterval(() => undefined, 1000);
} else {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    writeFileSync(capture, Buffer.concat(chunks), { mode: 0o600 });
    process.stdout.write("request id is Acceptance_XP58-42 (1 file(s))\\n");
  });
}
`;
  await writeFile(executable, source, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

export async function runPrintDispatchAcceptance({ env = process.env } = {}) {
  requiredEnvironment(env);
  const root = await mkdtemp(join(tmpdir(), "laundry-print-dispatch-"));
  const previous = Object.freeze({
    capture: process.env.LAUNDRY_ACCEPTANCE_LP_CAPTURE,
    invocations: process.env.LAUNDRY_ACCEPTANCE_LP_INVOCATIONS,
    mode: process.env.LAUNDRY_ACCEPTANCE_LP_MODE,
  });
  try {
    const edgeRoot = resolve("apps/edge-agent/dist");
    const [
      { generateEd25519Material },
      { createSignedAuthorityRequest },
      { PrintDispatchLedger },
      executorModule,
      cupsModule,
    ] = await Promise.all([
      import(pathToFileURL(join(edgeRoot, "pairing/device-keys.js")).href),
      import(pathToFileURL(join(edgeRoot, "desktop/edge-http.js")).href),
      import(pathToFileURL(join(edgeRoot, "print/dispatch-ledger.js")).href),
      import(pathToFileURL(join(edgeRoot, "print/signed-executor.js")).href),
      import(pathToFileURL(join(edgeRoot, "print/cups-process.js")).href),
    ]);
    const deviceId = randomUUID();
    const material = generateEd25519Material();
    const auth = await login(env, deviceId);
    const serverPublicKey = await pairDevice(
      auth,
      deviceId,
      material,
      createSignedAuthorityRequest,
    );
    const ledgerRoot = join(root, "ledger");
    const ledger = await PrintDispatchLedger.open(ledgerRoot);
    const executable = await createFakeLp(root);
    const capturePath = join(root, "escpos.bin");
    const invocationPath = join(root, "invocations.log");
    process.env.LAUNDRY_ACCEPTANCE_LP_CAPTURE = capturePath;
    process.env.LAUNDRY_ACCEPTANCE_LP_INVOCATIONS = invocationPath;
    process.env.LAUNDRY_ACCEPTANCE_LP_MODE = "success";
    const createExecutor = (timeoutMs) =>
      executorModule.createSignedPrintExecutor({
        ledger,
        deviceId,
        queue: QUEUE,
        devicePrivateKey: material.privateKey,
        serverPublicKey: () => serverPublicKey,
        discoverQueues: async () => Object.freeze([QUEUE]),
        submitCups: (queue, bytes) =>
          cupsModule.submitCupsBytesWithExecutable(queue, bytes, executable, timeoutMs),
        monotonicNowMs: () => performance.now(),
      });
    const orderId = await firstOrderId(auth);

    const successJob = await enqueue(auth, orderId);
    const successClaim = await claim(auth, successJob);
    const succeeded = await createExecutor(2_000).execute({
      dispatch: successClaim.dispatch,
      staffId: auth.staffId,
      timing: successClaim.timing,
      continuityTrusted: () => true,
    });
    assert.equal(succeeded.state, "cups_accepted");
    await settle(auth, ledger, succeeded, "done", "succeeded");
    validateCapturedEscPos(await readFile(capturePath));

    process.env.LAUNDRY_ACCEPTANCE_LP_MODE = "hang";
    const uncertainJob = await enqueue(auth, orderId);
    const uncertainClaim = await claim(auth, uncertainJob);
    const uncertain = await createExecutor(500).execute({
      dispatch: uncertainClaim.dispatch,
      staffId: auth.staffId,
      timing: uncertainClaim.timing,
      continuityTrusted: () => true,
    });
    assert.equal(uncertain.state, "uncertain");
    await settle(auth, ledger, uncertain, "uncertain", "uncertain");

    const invocationsBeforeRestart = (await readFile(invocationPath, "utf8")).trim().split("\n");
    assert.deepEqual(invocationsBeforeRestart, ["success", "hang"]);
    const restartedLedger = await PrintDispatchLedger.open(ledgerRoot);
    const restarted = executorModule.createSignedPrintExecutor({
      ledger: restartedLedger,
      deviceId,
      queue: QUEUE,
      devicePrivateKey: material.privateKey,
      serverPublicKey: () => serverPublicKey,
      discoverQueues: async () => Object.freeze([QUEUE]),
      submitCups: (queue, bytes) =>
        cupsModule.submitCupsBytesWithExecutable(queue, bytes, executable, 500),
      monotonicNowMs: () => performance.now(),
    });
    assert.deepEqual(await restarted.recoverInterrupted(), []);
    const idle = await protectedPost(
      auth,
      "/api/v2/edge/print/claim",
      { supported_printer_kinds: ["xp58"] },
      "PRINT_ACCEPTANCE_RESTART_CLAIM_FAILED",
      "desktop",
    );
    assert.equal(idle, null);
    assert.deepEqual(
      (await readFile(invocationPath, "utf8")).trim().split("\n"),
      invocationsBeforeRestart,
    );
  } catch (error) {
    if (error instanceof PrintDispatchAcceptanceError) throw error;
    throw new PrintDispatchAcceptanceError("PRINT_ACCEPTANCE_FAILED");
  } finally {
    for (const [name, value] of [
      ["LAUNDRY_ACCEPTANCE_LP_CAPTURE", previous.capture],
      ["LAUNDRY_ACCEPTANCE_LP_INVOCATIONS", previous.invocations],
      ["LAUNDRY_ACCEPTANCE_LP_MODE", previous.mode],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const isMainModule = () => {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
};

if (isMainModule()) {
  void runPrintDispatchAcceptance()
    .then(() => process.stdout.write("PRINT_DISPATCH_ACCEPTANCE_OK_FAKE_LP\n"))
    .catch((error) => {
      process.stderr.write(`${error?.code ?? "PRINT_ACCEPTANCE_FAILED"}\n`);
      process.exitCode = 1;
    });
}
