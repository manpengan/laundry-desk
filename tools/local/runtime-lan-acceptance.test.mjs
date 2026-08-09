import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { execute } from "../runtime-kit/real-container-lan-acceptance.mjs";

const noRepoUrl = new URL("../runtime-kit/no-repo-lan-acceptance.mjs", import.meta.url);
const acceptanceOrchestratorUrl = new URL(
  "../runtime-kit/runtime-app-acceptance.mjs",
  import.meta.url,
);
const acceptanceHelpersUrl = new URL("../runtime-kit/no-repo-helpers.mjs", import.meta.url);
const realContainerUrl = new URL(
  "../runtime-kit/real-container-lan-acceptance.mjs",
  import.meta.url,
);
const packageUrl = new URL("../../package.json", import.meta.url);
const foundationWorkflowUrl = new URL("../../.github/workflows/foundation.yml", import.meta.url);

const fakeChild = (onKill = () => undefined) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    onKill(child, signal);
    return true;
  };
  return Object.freeze({ child, signals });
};

const assertRunnerListenersCleaned = ({ child }) => {
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(child.stderr.listenerCount("data"), 0);
};

test(
  "real container child runner completes and clears its timeout",
  { timeout: 1_000 },
  async () => {
    let current;
    const output = await execute(
      "/fake/command",
      [],
      { label: "FAKE_NORMAL", timeoutMs: 10 },
      {
        graceMs: 10,
        spawn: () => {
          current = fakeChild();
          queueMicrotask(() => {
            current.child.stdout.emit("data", Buffer.from("ready"));
            current.child.emit("close", 0);
          });
          return current.child;
        },
      },
    );
    assert.equal(output, "ready");
    await delay(25);
    assert.deepEqual(current.signals, []);
    assertRunnerListenersCleaned(current);
  },
);

test("real container child runner hides failed-command output", { timeout: 1_000 }, async () => {
  let current;
  await assert.rejects(
    execute(
      "/fake/command",
      [],
      { label: "FAKE_FAILURE", timeoutMs: 20 },
      {
        graceMs: 10,
        spawn: () => {
          current = fakeChild();
          queueMicrotask(() => {
            current.child.stderr.emit("data", Buffer.from("secret-stderr"));
            current.child.emit("close", 1);
          });
          return current.child;
        },
      },
    ),
    { message: "FAKE_FAILURE_FAILED" },
  );
  assert.deepEqual(current.signals, []);
  assertRunnerListenersCleaned(current);
});

test("real container child timeout uses TERM and a stable error", { timeout: 1_000 }, async () => {
  let current;
  await assert.rejects(
    execute(
      "/fake/command",
      [],
      { label: "FAKE_TERM", timeoutMs: 5 },
      {
        graceMs: 10,
        spawn: () => {
          current = fakeChild((child, signal) => {
            if (signal === "SIGTERM") {
              child.stderr.emit("data", Buffer.from("secret-stderr"));
              queueMicrotask(() => child.emit("close", null, signal));
            }
          });
          return current.child;
        },
      },
    ),
    { message: "FAKE_TERM_TIMEOUT" },
  );
  await delay(20);
  assert.deepEqual(current.signals, ["SIGTERM"]);
  assertRunnerListenersCleaned(current);
});

test(
  "real container child timeout escalates an unresponsive child to KILL",
  { timeout: 1_000 },
  async () => {
    let current;
    let closed = false;
    await assert.rejects(
      execute(
        "/fake/command",
        [],
        { label: "FAKE_STUBBORN", timeoutMs: 5, visible: true },
        {
          graceMs: 10,
          spawn: () => {
            current = fakeChild((child, signal) => {
              if (signal === "SIGKILL") {
                closed = true;
                queueMicrotask(() => child.emit("close", null, signal));
              }
            });
            return current.child;
          },
        },
      ),
      { message: "FAKE_STUBBORN_TIMEOUT" },
    );
    assert.deepEqual(current.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(closed, true);
    assertRunnerListenersCleaned(current);
  },
);

test("LAN native acceptance is repository-independent and exercises the frozen CLI", async () => {
  const source = await readFile(noRepoUrl, "utf8");

  assert.match(source, /cwd: emptyCwd/u);
  assert.match(source, /env:\s*\{\s*PATH: ""/u);
  for (const command of [
    '["lan", "configure"]',
    '["lan", "enable"]',
    '["lan", "disable"]',
    '["lan", "status"]',
    '["lan", "onboard"]',
    '["lan", "diagnose"]',
    '["support", "create"]',
  ]) {
    assert.ok(source.includes(command), `missing ${command}`);
  }
  assert.match(source, /"config\.json"/u);
  assert.match(source, /mode & 0o777, 0o600/u);
  assert.match(source, /supportMetadata\.size <= 256 \* 1024/u);
  assert.match(source, /launchd/u);
  assert.match(source, /RUNTIME_LAN_MANIFEST_V2_REQUIRED/u);
  assert.doesNotMatch(source, /child_process\.(?:exec|execSync)|shell:\s*true/u);
});

test("real container LAN acceptance owns isolated resources and proves network fail-closed", async () => {
  const source = await readFile(realContainerUrl, "utf8");

  assert.match(source, /laundry-lan-accept-/u);
  assert.match(source, /replaceAll\("laundry-desk-runtime_pgdata-v2", databaseVolume\)/u);
  assert.match(source, /replaceAll\("laundry-desk-runtime_photos", photoVolume\)/u);
  assert.match(source, /docker-compose\.runtime-lan\.yml/u);
  assert.match(source, /loadLanStaticAssets\(webRoot\)/u);
  assert.match(source, /playwright\.lan\.config\.ts/u);
  assert.match(source, /tcpConnects\(lanHost, 8787\)/u);
  assert.match(source, /tcpConnects\(lanHost, 8543\)/u);
  for (const boundary of [
    'host: "wrong.invalid"',
    'forwarded: "for=192.0.2.1"',
    '"x-forwarded-for": "192.0.2.1"',
    'path: "/v1/commands/order.receive"',
    'path: "/"',
    'path: "/index.html"',
  ]) {
    assert.ok(source.includes(boundary), `missing ${boundary}`);
  }
  assert.match(source, /com\.laundry-desk\.project/u);
  assert.match(source, /compose, "rm", "--stop", "--force", "lan-gateway"/u);
  assert.match(source, /portCanBind\(lanHost, lanPort\)/u);
  assert.match(source, /baseOnlyCompose/u);
  assert.match(source, /SERVER_RELEASE_LAN_PORT_AFTER_DISABLE/u);
  for (const option of ["--force-recreate", "--no-deps"]) {
    assert.ok(source.includes(`"${option}"`), `missing ${option}`);
  }
  assert.match(source, /requestLoopbackHealth\(\)/u);
  assert.match(source, /compose, "up", "--detach", "--wait", "lan-gateway"/u);
  assert.match(source, /\.State\.Health\.Status/u);
  assert.match(source, /SERVER_RELEASE_LAN_PORT_FOR_RECONFIGURE/u);
  assert.match(source, /lifecycle=plain-disable-reenable-and-reconfigure-clean/u);
  assert.match(source, /compose, "down", "--remove-orphans"/u);
  assert.match(source, /volume", "rm", "--force"/u);
  assert.match(source, /image", "rm", "--force"/u);
  assert.doesNotMatch(source, /child_process\.(?:exec|execSync)|shell:\s*true/u);
});

test("package commands expose the complete Stage 2 LAN acceptance", async () => {
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8"));
  const nativeAcceptance = "node tools/runtime-kit/runtime-app-acceptance.mjs";

  assert.equal(packageJson.scripts["runtime:app:acceptance"], nativeAcceptance);
  const [orchestrator, helpers] = await Promise.all([
    readFile(acceptanceOrchestratorUrl, "utf8"),
    readFile(acceptanceHelpersUrl, "utf8"),
  ]);
  assert.equal(orchestrator.match(/"--orchestrated"/gu)?.length, 1);
  assert.match(orchestrator, /finally\s*\{\s*await rm\(signingKey, \{ force: true \}\)/u);
  assert.match(helpers, /process\.once\("exit"/u);
  assert.match(helpers, /rmSync\(path, \{ force: true \}\)/u);
  assert.equal(
    packageJson.scripts["runtime:lan:container:acceptance"],
    "node tools/runtime-kit/real-container-lan-acceptance.mjs",
  );
  assert.equal(
    packageJson.scripts["runtime:lan:acceptance"],
    "pnpm runtime:lan:no-repo:acceptance && pnpm runtime:lan:container:acceptance",
  );

  const foundationWorkflow = await readFile(foundationWorkflowUrl, "utf8");
  assert.match(
    foundationWorkflow,
    /name: Build, inspect, and run no-repo Runtime and LAN acceptance\n\s+run: pnpm run runtime:app:acceptance/u,
  );
});
