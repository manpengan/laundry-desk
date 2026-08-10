import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const workflowPath = join(repositoryRoot, ".github/workflows/v2-integration.yml");
const execFileAsync = promisify(execFile);

function extractStepScript(workflow, name, nextName) {
  const start = workflow.indexOf(`      - name: ${name}`);
  const end = workflow.indexOf(`      - name: ${nextName}`, start);
  assert.ok(start >= 0 && end > start);
  const section = workflow.slice(start, end);
  const runMarker = "        run: |\n";
  const runStart = section.indexOf(runMarker);
  assert.ok(runStart >= 0);
  return section
    .slice(runStart + runMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

async function writeExecutable(path, source) {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

test("restores an exact-health server after the write gate fails", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "laundry-v2-integration-workflow-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const binaryDirectory = join(directory, "bin");
  await execFileAsync("mkdir", ["-p", binaryDirectory]);
  const tracePath = join(directory, "trace.log");

  await writeExecutable(
    join(binaryDirectory, "docker"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >> "${"$"}{FAKE_TRACE}"
`,
  );
  await writeExecutable(
    join(binaryDirectory, "pnpm"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'pnpm %s\n' "$*" >> "${"$"}{FAKE_TRACE}"
[[ "$*" == 'local:up -- --bootstrap' ]]
`,
  );
  await writeExecutable(
    join(binaryDirectory, "curl"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
output=''
while (( $# > 0 )); do
  if [[ "$1" == '--output' ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
[[ -n "${"$"}{output}" ]]
printf '%s' '{"ok":true,"data":{"status":"ready"}}' > "${"$"}{output}"
printf '%s\n' 'curl health' >> "${"$"}{FAKE_TRACE}"
`,
  );
  await writeExecutable(
    join(binaryDirectory, "node"),
    String.raw`#!/usr/bin/env bash
set -euo pipefail
if [[ "${"$"}{1:-}" == 'tools/cloud/hk-vps-release-catalog-pg-acceptance.mjs' ]]; then
  printf '%s\n' 'node gate' >> "${"$"}{FAKE_TRACE}"
  exit "${"$"}{FAKE_GATE_STATUS}"
fi
printf '%s\n' 'node health' >> "${"$"}{FAKE_TRACE}"
exec "${"$"}{REAL_NODE}" "$@"
`,
  );

  const workflow = await readFile(workflowPath, "utf8");
  const script = extractStepScript(
    workflow,
    "Verify release catalog and write gate against real PostgreSQL",
    "Assert RLS and real server HTTP smoke",
  );
  assert.match(script, /^trap restore_server EXIT$/mu);
  assert.doesNotMatch(script, /local:down|docker volume|stop postgres/u);

  await assert.rejects(
    execFileAsync("bash", ["-c", script], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${binaryDirectory}:${process.env.PATH}`,
        COMPOSE_PROJECT_NAME: "laundry-ci-test",
        FAKE_GATE_STATUS: "41",
        FAKE_TRACE: tracePath,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "2",
        REAL_NODE: process.execPath,
        RUNNER_TEMP: directory,
      },
    }),
    (error) => error.code === 41,
  );

  assert.deepEqual((await readFile(tracePath, "utf8")).trim().split("\n"), [
    "docker compose -p laundry-ci-test -f tools/compose/docker-compose.yml stop server",
    "node gate",
    "pnpm local:up -- --bootstrap",
    "curl health",
    "node health",
  ]);
});
