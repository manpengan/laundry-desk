import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runCupsWorkerOnce } from "./cups-worker.js";

const QUEUE = "xp58-local";
const ARTIFACT = "11111111-1111-4111-8111-111111111111-xp58-0001.txt";
const cupsTest = process.platform === "win32" ? test.skip : test;

async function fixture(): Promise<Readonly<{ root: string; spool: string; state: string }>> {
  const root = await mkdtemp(join(tmpdir(), "laundry-cups-worker-"));
  const spool = join(root, "spool");
  const state = join(root, "state");
  await Promise.all([mkdir(spool, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
  await writeFile(join(spool, ARTIFACT), "LAUNDRY TEST\n", { mode: 0o600 });
  return Object.freeze({ root, spool, state });
}

cupsTest("CUPS worker submits one new artifact and persists an idempotent receipt", async () => {
  const dirs = await fixture();
  let submissions = 0;
  try {
    const dependencies = {
      discover: async () => Object.freeze([QUEUE]),
      submit: async (_queue: string, bytes: Uint8Array) => {
        submissions += 1;
        assert.equal(Buffer.from(bytes).toString("utf8"), "LAUNDRY TEST\n");
        return `${QUEUE}-42`;
      },
      now: () => 100,
      platform: "darwin" as const,
    };
    const first = await runCupsWorkerOnce(
      { queue: QUEUE, spoolRoot: dirs.spool, stateRoot: dirs.state },
      dependencies,
    );
    assert.deepEqual(first, {
      state: "submitted",
      queue: QUEUE,
      artifact: ARTIFACT,
      cups_job_id: `${QUEUE}-42`,
      message: "Print artifact submitted to CUPS",
    });
    const second = await runCupsWorkerOnce(
      { queue: QUEUE, spoolRoot: dirs.spool, stateRoot: dirs.state },
      dependencies,
    );
    assert.equal(second.state, "idle");
    assert.equal(submissions, 1);
    const persisted = await readFile(join(dirs.state, "cups-worker-state.json"), "utf8");
    assert.doesNotMatch(persisted, /LAUNDRY TEST/u);
    assert.match(persisted, /"state":"submitted"/u);
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

cupsTest(
  "CUPS worker leaves an uncertain marker instead of risking a duplicate print",
  async () => {
    const dirs = await fixture();
    let submissions = 0;
    try {
      const dependencies = {
        discover: async () => Object.freeze([QUEUE]),
        submit: async () => {
          submissions += 1;
          return "untrackable";
        },
        platform: "darwin" as const,
      };
      const first = await runCupsWorkerOnce(
        { queue: QUEUE, spoolRoot: dirs.spool, stateRoot: dirs.state },
        dependencies,
      );
      assert.equal(first.state, "uncertain");
      const second = await runCupsWorkerOnce(
        { queue: QUEUE, spoolRoot: dirs.spool, stateRoot: dirs.state },
        dependencies,
      );
      assert.equal(second.state, "uncertain");
      assert.equal(submissions, 1);
    } finally {
      await rm(dirs.root, { recursive: true, force: true });
    }
  },
);

cupsTest("CUPS worker rejects an unavailable configured queue without writing state", async () => {
  const dirs = await fixture();
  try {
    const result = await runCupsWorkerOnce(
      { queue: QUEUE, spoolRoot: dirs.spool, stateRoot: dirs.state },
      {
        discover: async () => Object.freeze([]),
        submit: async () => `${QUEUE}-1`,
        platform: "darwin",
      },
    );
    assert.equal(result.state, "failed");
    await assert.rejects(() => readFile(join(dirs.state, "cups-worker-state.json")));
  } finally {
    await rm(dirs.root, { recursive: true, force: true });
  }
});

cupsTest(
  "CUPS state drops submitted receipts only after their retained artifact is gone",
  async () => {
    const dirs = await fixture();
    const staleArtifact = "22222222-2222-4222-8222-222222222222-xp58-0001.txt";
    try {
      await writeFile(
        join(dirs.state, "cups-worker-state.json"),
        `${JSON.stringify({
          version: 1,
          records: [
            {
              artifact: staleArtifact,
              sha256: "a".repeat(64),
              state: "submitted",
              cups_job_id: `${QUEUE}-1`,
              updated_at: 1,
            },
          ],
        })}\n`,
        { mode: 0o600 },
      );
      const result = await runCupsWorkerOnce(
        { queue: QUEUE, spoolRoot: dirs.spool, stateRoot: dirs.state },
        {
          discover: async () => Object.freeze([QUEUE]),
          submit: async () => `${QUEUE}-2`,
          platform: "darwin",
        },
      );

      assert.equal(result.state, "submitted");
      const persisted = await readFile(join(dirs.state, "cups-worker-state.json"), "utf8");
      assert.doesNotMatch(persisted, new RegExp(staleArtifact, "u"));
      assert.match(persisted, new RegExp(ARTIFACT, "u"));
    } finally {
      await rm(dirs.root, { recursive: true, force: true });
    }
  },
);
