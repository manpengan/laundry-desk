import assert from "node:assert/strict";
import test from "node:test";

import { REMOTE_RELEASE_LOCK } from "./hk-vps-release-core.mjs";
import {
  MAINTENANCE_ROOT,
  installMaintenanceTree,
  isDirectEntrypoint,
  maintenanceIncomingPath,
  maintenanceInstallScript,
  maintenancePrepareScript,
  maintenanceTreePath,
  parseMaintenanceArguments,
} from "./hk-vps-release-maintenance.mjs";

const CANDIDATE = "a".repeat(40);
const NONCE = "b".repeat(32);
const DIGEST = "c".repeat(64);

test("maintenance identity permits only exact SHA and non-secret nonce paths", () => {
  assert.equal(
    maintenanceIncomingPath(CANDIDATE, NONCE),
    `${MAINTENANCE_ROOT}/incoming-${CANDIDATE}-${NONCE}.tar`,
  );
  assert.equal(maintenanceTreePath(CANDIDATE), `${MAINTENANCE_ROOT}/trees/${CANDIDATE}`);
  assert.deepEqual(parseMaintenanceArguments(["--candidate-sha", CANDIDATE]), {
    candidateSha: CANDIDATE,
  });
  assert.deepEqual(parseMaintenanceArguments(["--", "--candidate-sha", CANDIDATE]), {
    candidateSha: CANDIDATE,
  });
  for (const arguments_ of [
    [],
    ["--candidate-sha", "short"],
    ["--candidate-sha", CANDIDATE, "extra"],
    ["--other", CANDIDATE],
  ]) {
    assert.throws(() => parseMaintenanceArguments(arguments_));
  }
  assert.throws(() => maintenanceIncomingPath(CANDIDATE, "../escape"), {
    code: "CLOUD_RELEASE_MAINTENANCE_NONCE_INVALID",
  });
});

test("remote bootstrap is root-private, locked, transition-free and exact-archive bound", () => {
  const prepare = maintenancePrepareScript();
  assert.match(prepare, new RegExp(`root=${MAINTENANCE_ROOT}`, "u"));
  assert.match(prepare, /mkdir -m 0700/u);
  assert.match(prepare, /root:root:700/u);
  assert.equal(prepare.includes('test ! -e "${incoming}"'), true);

  const install = maintenanceInstallScript();
  assert.match(install, new RegExp(`lock=${REMOTE_RELEASE_LOCK.replaceAll("/", "\\/")}`, "u"));
  assert.match(install, /flock -n 9/u);
  assert.match(install, /transition\.json/u);
  assert.equal(install.includes('sha256sum -- "${incoming}"'), true);
  assert.match(install, /--no-same-owner --no-same-permissions/u);
  assert.equal(install.includes('test -z "$(find "${stage}" -type l'), true);
  assert.match(install, /hk-vps-release-artifact-archive-run\.mjs/u);
  assert.match(install, /hk-vps-release-set-archive-run\.mjs/u);
  assert.doesNotMatch(install, /rm -rf/u);
  assert.doesNotMatch(install, /\/opt\/laundry-desk(?:\s|"|'|$)/u);
});

test("local installer checks exact green main, pins SSH, uploads once and cleans only local temp", async () => {
  const calls = [];
  const removed = [];
  let repositoryChecks = 0;
  const context = Object.freeze({ cwd: "/repo", environment: Object.freeze({}) });
  const result = await installMaintenanceTree(
    context,
    { candidateSha: CANDIDATE },
    {
      assertRepositoryCandidate: async (received, candidate, execute) => {
        assert.equal(received, context);
        assert.equal(candidate, CANDIDATE);
        assert.equal(typeof execute, "function");
        repositoryChecks += 1;
      },
      command: async (_context, file, arguments_, label, _timeout, extra = {}) => {
        calls.push({ arguments_, file, input: extra.input, label });
        return Object.freeze({ code: 0, stderr: "", stdout: `${label}_OK\n` });
      },
      createArchive: async () => ({
        archivePath: "/private/tmp/exact-main.tar",
        digest: DIGEST,
        temporaryRoot: "/private/tmp/exact-main-root",
      }),
      randomBytes: () => Buffer.from("ab".repeat(16), "hex"),
      rm: async (path, options) => removed.push({ options, path }),
      withPinnedSshAuthority: async (_execute, operation) =>
        await operation({ path: "/private/tmp/known_hosts" }),
    },
  );

  assert.equal(repositoryChecks, 1);
  assert.equal(result.candidateSha, CANDIDATE);
  assert.equal(result.archiveSha256, DIGEST);
  assert.equal(result.tree, maintenanceTreePath(CANDIDATE));
  assert.deepEqual(
    calls.map(({ label }) => label),
    [
      "CLOUD_RELEASE_MAINTENANCE_PREPARE",
      "CLOUD_RELEASE_MAINTENANCE_UPLOAD",
      "CLOUD_RELEASE_MAINTENANCE_INSTALL",
    ],
  );
  const upload = calls[1];
  assert.equal(upload.file, "/usr/bin/scp");
  assert.equal(
    upload.arguments_.at(-1),
    `hk-vps:${maintenanceIncomingPath(CANDIDATE, "ab".repeat(16))}`,
  );
  assert.equal(calls[0].input, maintenancePrepareScript());
  assert.equal(calls[2].input, maintenanceInstallScript());
  assert.deepEqual(removed, [
    {
      options: { force: true, recursive: true },
      path: "/private/tmp/exact-main-root",
    },
  ]);
});

test("local installer still cleans its exact temporary root after remote failure", async () => {
  const removed = [];
  await assert.rejects(
    () =>
      installMaintenanceTree(
        { cwd: "/repo", environment: {} },
        { candidateSha: CANDIDATE },
        {
          assertRepositoryCandidate: async () => undefined,
          command: async (_context, _file, _arguments, label) => {
            if (label === "CLOUD_RELEASE_MAINTENANCE_INSTALL") throw new Error("remote failed");
            return { stdout: "" };
          },
          createArchive: async () => ({
            archivePath: "/tmp/archive",
            digest: DIGEST,
            temporaryRoot: "/tmp/exact-temp",
          }),
          randomBytes: () => Buffer.alloc(16),
          rm: async (path) => removed.push(path),
          withPinnedSshAuthority: async (_execute, operation) =>
            await operation({ path: "/tmp/known" }),
        },
      ),
    /remote failed/u,
  );
  assert.deepEqual(removed, ["/tmp/exact-temp"]);
});

test("runner self-execution check is exact", () => {
  const moduleUrl = new URL("./hk-vps-release-maintenance.mjs", import.meta.url).href;
  assert.equal(isDirectEntrypoint(undefined, moduleUrl), false);
  assert.equal(isDirectEntrypoint("/other.mjs", moduleUrl), false);
});
