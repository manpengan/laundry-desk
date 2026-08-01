import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CupsSubmissionError,
  discoverCupsQueuesWithExecutable,
  parseCupsJobReference,
  submitCupsBytesWithExecutable,
} from "./cups-process.js";
import { isCupsJobIdForQueue, isCupsQueueName } from "./cups-queue.js";

const QUEUE = "xp58-local";

async function fakeLp(
  root: string,
  body: string,
): Promise<Readonly<{ executable: string; args: string; stdin: string }>> {
  const executable = join(root, "fake-lp.mjs");
  const args = join(root, "args.json");
  const stdin = join(root, "stdin.bin");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(args)}, JSON.stringify(process.argv.slice(2)));
  writeFileSync(${JSON.stringify(stdin)}, Buffer.concat(chunks));
  ${body}
});
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return Object.freeze({ executable, args, stdin });
}

test("fake lp receives only explicit queue/raw args and exact ESC/POS bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-fake-lp-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fake = await fakeLp(
    root,
    `process.stdout.write("request id is ${QUEUE}-42 (1 file(s))\\n");`,
  );
  const bytes = Uint8Array.of(0x1b, 0x40, 0x0a, 0x1d, 0x56, 0x01);

  const jobId = await submitCupsBytesWithExecutable(QUEUE, bytes, fake.executable, 2_000);

  assert.equal(jobId, `${QUEUE}-42`);
  assert.deepEqual(JSON.parse(await readFile(fake.args, "utf8")), ["-d", QUEUE, "-o", "raw"]);
  assert.deepEqual(new Uint8Array(await readFile(fake.stdin)), bytes);
});

test("waits for close and parses stdout delivered after the lp process exits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-fake-lp-late-stdout-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const writer = `setTimeout(() => process.stdout.write(${JSON.stringify(
    `request id is ${QUEUE}-314 (1 file(s))\n`,
  )}), 50)`;
  const fake = await fakeLp(
    root,
    `const late = spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], {
      stdio: ["ignore", process.stdout, "ignore"],
    });
    late.unref();`,
  );

  const jobId = await submitCupsBytesWithExecutable(
    QUEUE,
    Uint8Array.of(0x1b, 0x40),
    fake.executable,
    2_000,
  );

  assert.equal(jobId, `${QUEUE}-314`);
});

test("CUPS job reference must be unique and bound to the configured queue", () => {
  assert.equal(parseCupsJobReference(QUEUE, `request id is ${QUEUE}-9 (1 file(s))`), `${QUEUE}-9`);
  assert.throws(
    () => parseCupsJobReference(QUEUE, "request id is other-9 (1 file(s))"),
    (error: unknown) => error instanceof CupsSubmissionError && error.outcome === "uncertain",
  );
  assert.throws(
    () => parseCupsJobReference(QUEUE, `${QUEUE}-1 ${QUEUE}-2`),
    (error: unknown) => error instanceof CupsSubmissionError && error.outcome === "uncertain",
  );
  assert.throws(
    () => parseCupsJobReference(QUEUE, `${QUEUE}-0`),
    (error: unknown) => error instanceof CupsSubmissionError && error.outcome === "uncertain",
  );
});

test("CUPS queue contract accepts 64 bytes, rejects 65, and requires a positive job number", () => {
  const maxQueue = "q".repeat(64);
  const oversizedQueue = "q".repeat(65);
  assert.equal(isCupsQueueName(maxQueue), true);
  assert.equal(isCupsQueueName(oversizedQueue), false);
  assert.equal(isCupsJobIdForQueue(maxQueue, `${maxQueue}-1`), true);
  assert.equal(isCupsJobIdForQueue(maxQueue, `${maxQueue}-0`), false);
  assert.equal(isCupsJobIdForQueue(maxQueue, `${maxQueue}-1234567890`), true);
  assert.equal(isCupsJobIdForQueue(maxQueue, `${maxQueue}-12345678901`), false);
  assert.equal(parseCupsJobReference(maxQueue, `${maxQueue}-1`), `${maxQueue}-1`);
  assert.throws(() => parseCupsJobReference(maxQueue, `${maxQueue}-12345678901`));
  assert.throws(() => parseCupsJobReference(oversizedQueue, `${oversizedQueue}-1`));
});

test("timeout after fake lp spawn is uncertain and never reported as a known failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-fake-lp-timeout-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fake = await fakeLp(root, "setTimeout(() => undefined, 5_000);");

  await assert.rejects(
    () => submitCupsBytesWithExecutable(QUEUE, Uint8Array.of(1), fake.executable, 50),
    (error: unknown) =>
      error instanceof CupsSubmissionError &&
      error.outcome === "uncertain" &&
      error.message === "CUPS submission timed out",
  );
});

test("any nonzero exit after lp spawn is uncertain; only pre-spawn failure is failed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-fake-lp-failed-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fake = await fakeLp(
    root,
    'process.stderr.write("queue stopped\\n"); process.exitCode = 2;',
  );

  await assert.rejects(
    () => submitCupsBytesWithExecutable(QUEUE, Uint8Array.of(1), fake.executable, 2_000),
    (error: unknown) => error instanceof CupsSubmissionError && error.outcome === "uncertain",
  );
  await assert.rejects(
    () => submitCupsBytesWithExecutable(QUEUE, Uint8Array.of(1), join(root, "missing-lp"), 100),
    (error: unknown) => error instanceof CupsSubmissionError && error.outcome === "failed",
  );
});

test("an external signal remains distinct from an exit code or timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-fake-lp-signal-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fake = await fakeLp(root, 'process.kill(process.pid, "SIGTERM");');

  await assert.rejects(
    () => submitCupsBytesWithExecutable(QUEUE, Uint8Array.of(1), fake.executable, 2_000),
    (error: unknown) =>
      error instanceof CupsSubmissionError &&
      error.outcome === "uncertain" &&
      error.message === "CUPS submission terminated by SIGTERM",
  );
});

test("fake lp output is hard-capped before parsing a job reference", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-fake-lp-output-cap-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const fake = await fakeLp(root, `process.stdout.write("X".repeat(4096) + " ${QUEUE}-77\\n");`);

  await assert.rejects(
    () => submitCupsBytesWithExecutable(QUEUE, Uint8Array.of(1), fake.executable, 2_000),
    (error: unknown) => error instanceof CupsSubmissionError && error.outcome === "uncertain",
  );
});

test("CUPS discovery is bounded and kills a hung backend", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "laundry-fake-lpstat-timeout-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const executable = join(root, "fake-lpstat.mjs");
  await writeFile(executable, "#!/usr/bin/env node\nsetInterval(() => undefined, 1000);\n", {
    mode: 0o700,
  });
  await chmod(executable, 0o700);

  await assert.rejects(
    () => discoverCupsQueuesWithExecutable(executable, 50),
    (error: unknown) =>
      typeof error === "object" && error !== null && Reflect.get(error, "killed") === true,
  );
});
