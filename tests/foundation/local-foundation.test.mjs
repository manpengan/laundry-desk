import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const rootUrl = new URL("../../", import.meta.url);
const governanceFiles = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GROK.md",
  "GEMINI.md",
  "HERMES.md",
];
const currentDeliveryAdr = "(docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)";
const activeV2ProductEntries = [
  "apps/server/src/local/create-runtime.ts",
  "apps/server/src/http/main.ts",
  "apps/web/host/main.tsx",
  "apps/web/src/auth/HttpAuthClient.ts",
];
const activeV2CredentialOutputEntries = ["apps/server/src/http/main.ts", "apps/web/host/main.tsx"];
const task3bIntegrationFiles = [
  "tools/compose/docker-compose.yml",
  "tools/compose/migrate-v2.sh",
  "tools/compose/smoke-rls.sh",
  "tools/compose/smoke-test.sh",
  ".github/workflows/v2-integration.yml",
  "apps/web/e2e/local-login.spec.ts",
];
const activeV2ProfileConsumers = [
  "apps/server/src/local/create-runtime.ts",
  "apps/server/src/http/main.ts",
  "apps/web/host/main.tsx",
  "apps/web/src/auth/HttpAuthClient.ts",
];
const demoCredentialMarkers = [
  ["DEMO_PASSWORD", /\bDEMO_PASSWORD\b/u],
  ["DEMO_PIN", /\bDEMO_PIN\b/u],
  ["demo literal", /(["'`])demo\1/iu],
  ["1234 literal", /\b1234\b/u],
];
const localProfileCopyMarkers = [
  ["org code", /(["'`])local\1/u],
  ["store code", /(["'`])main\1/u],
  ["org name", /laundry-desk V2/u],
  ["store name", /本地门店/u],
  ["timezone", /Asia\/Taipei/u],
  ["admin staff id", /11111111-1111-4111-8111-111111111103/u],
];
const outputCallPattern =
  /\b(?:console\.(?:log|info|warn|error)|process\.(?:stdout|stderr)\.write)\s*\([\s\S]*?\)\s*;?/gu;
const credentialOutputLabelPattern = /\b(?:password|credential|secret)\b/iu;
const pinOutputLabelPattern = /\bPIN\b/u;

async function readRepositoryFile(path) {
  return readFile(new URL(path, rootUrl), "utf8");
}

async function listRepositoryFiles(directory) {
  const entries = await readdir(new URL(`${directory}/`, rootUrl), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? listRepositoryFiles(path) : [path];
    }),
  );
  return nested.flat();
}

function findServerSeedBoundaryViolations(sources) {
  const violations = [];
  for (const [path, source] of sources) {
    if (path.endsWith("/pg-seed.ts")) {
      violations.push(`${path}: legacy production seed module`);
    }
    if (/\bseedDemoIdentity\b/u.test(source)) {
      violations.push(`${path}: seedDemoIdentity production reference`);
    }
    if (/pg-test-fixture/u.test(source) && !path.endsWith(".test.ts")) {
      violations.push(`${path}: test fixture imported outside *.test.ts`);
    }
  }
  return violations;
}

function findDemoCredentialMarkers(source) {
  return demoCredentialMarkers
    .filter(([, pattern]) => pattern.test(source))
    .map(([label]) => label);
}

function findCredentialOutputCalls(source) {
  return [...source.matchAll(outputCallPattern)]
    .map(([call]) => call)
    .filter((call) => credentialOutputLabelPattern.test(call) || pinOutputLabelPattern.test(call));
}

function findLocalProfileCopies(source) {
  return localProfileCopyMarkers
    .filter(([, pattern]) => pattern.test(source))
    .map(([label]) => label);
}

test("routes every governance entry point to ADR-14", async () => {
  const contents = await Promise.all(governanceFiles.map(readRepositoryFile));
  const missingLinks = governanceFiles.filter(
    (_file, index) => !contents[index].includes(currentDeliveryAdr),
  );

  assert.deepEqual(missingLinks, []);
});

test("leads the README with the generic local Web and macOS route", async () => {
  const readmeLead = (await readRepositoryFile("README.md")).slice(0, 1500);

  assert.match(readmeLead, /通用 V2.*本地 Web.*macOS/su);
});

test("does not advertise stale Hongfa or Grok delivery ownership in the README lead", async () => {
  const readmeLead = (await readRepositoryFile("README.md")).slice(0, 1500);

  assert.doesNotMatch(readmeLead, /宏发升级候选版|Grok 单一技术负责人/u);
});

test("keeps Gemini legacy v1 execution guidance inside one forbidden archive block", async () => {
  const gemini = await readRepositoryFile("GEMINI.md");
  const archiveHeading = "## 历史 v1 资料（已归档，禁止执行）";
  const archiveStart = gemini.indexOf(archiveHeading);

  assert.notEqual(archiveStart, -1, "Gemini must open an explicit legacy v1 archive block");

  const archiveBlock = gemini.slice(archiveStart);
  assert.doesNotMatch(
    archiveBlock.slice(archiveHeading.length),
    /^## /mu,
    "Gemini legacy guidance must remain inside the archive block through EOF",
  );
  assert.match(
    archiveBlock,
    /以下.*目录骨架.*开发与提交流程.*构建与发布命令.*问题处理.*“不做”规则.*禁止执行/su,
  );
  for (const section of [
    "### 目录骨架（历史）",
    "### 分期任务（历史，禁止执行）",
    "### 开发与提交流程（历史，禁止执行）",
    "### 构建与发布命令（历史，禁止执行）",
    "### 问题处理（历史，禁止执行）",
    "### 不做（历史，禁止执行）",
  ]) {
    assert.ok(archiveBlock.includes(section), `${section} must stay inside the archive block`);
  }
});

test("runs every foundation test from the default workspace test gate", async () => {
  const rootPackage = JSON.parse(await readRepositoryFile("package.json"));

  assert.equal(
    rootPackage.scripts["workspace:test"],
    "node --test tests/foundation/*.test.mjs && turbo run test",
  );
});

test("uses the generic V2 display name in active packaging metadata", async () => {
  const rootPackage = JSON.parse(await readRepositoryFile("package.json"));

  assert.equal(rootPackage.build.productName, "laundry-desk V2");
  assert.equal(rootPackage.build.nsis.shortcutName, "laundry-desk V2");
});

test("keeps the default memory server entry independent from PG signing secrets", async () => {
  const serverEntry = await readRepositoryFile("apps/server/src/http/main.ts");

  assert.match(serverEntry, /parseLocalHostConfig/u);
  assert.doesNotMatch(serverEntry, /parseLocalServerConfig/u);
});

test("keeps product and credential defaults out of active V2 entry points", async () => {
  const contents = await Promise.all(activeV2ProductEntries.map(readRepositoryFile));

  for (const [index, content] of contents.entries()) {
    assert.doesNotMatch(
      content,
      /Hongfa Laundry|hongfa|宏发/iu,
      `${activeV2ProductEntries[index]} must stay generic`,
    );
  }

  for (const path of activeV2CredentialOutputEntries) {
    const content = await readRepositoryFile(path);
    assert.deepEqual(findDemoCredentialMarkers(content), [], `${path} must not embed demo creds`);
    assert.deepEqual(findCredentialOutputCalls(content), [], `${path} must not print credentials`);
  }
});

test("credential output gate rejects multiline and indirect demo credential references", () => {
  const multiline = "process.stdout.write(`password=\\n${DEMO_PASSWORD}`);";
  const indirect = "const value = DEMO_PIN;\nconsole.info(value);";
  const unlabeledSource = 'const value = getSecret();\nconsole.info("PIN", value);';

  assert.deepEqual(findDemoCredentialMarkers(multiline), ["DEMO_PASSWORD"]);
  assert.equal(findCredentialOutputCalls(multiline).length, 1);
  assert.deepEqual(findDemoCredentialMarkers(indirect), ["DEMO_PIN"]);
  assert.equal(findCredentialOutputCalls(unlabeledSource).length, 1);
});

test("centralizes generic local identity in the server profile module", async () => {
  const profile = await readRepositoryFile("apps/server/src/local/profile.ts");
  const consumers = await Promise.all(activeV2ProfileConsumers.map(readRepositoryFile));

  assert.match(profile, /orgCode:\s*"local"/u);
  assert.match(profile, /storeCode:\s*"main"/u);
  assert.match(profile, /orgName:\s*"laundry-desk V2"/u);
  assert.match(profile, /storeName:\s*"本地门店"/u);
  assert.match(profile, /timezone:\s*"Asia\/Taipei"/u);

  for (const [index, content] of consumers.entries()) {
    assert.deepEqual(
      findLocalProfileCopies(content),
      [],
      `${activeV2ProfileConsumers[index]} must read identity values from LOCAL_PROFILE`,
    );
    assert.doesNotMatch(
      content,
      /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/u,
    );
  }
});

test("profile copy gate catches camelCase, snake_case, and exact literals", () => {
  const copiedConstants = [
    'const orgCode = "local";',
    'const store_code = "main";',
    'const org_name = "laundry-desk V2";',
    'const storeName = "本地门店";',
    'const timezone = "Asia/Taipei";',
    'const adminStaffId = "11111111-1111-4111-8111-111111111103";',
  ].join("\n");

  assert.deepEqual(findLocalProfileCopies(copiedConstants), [
    "org code",
    "store code",
    "org name",
    "store name",
    "timezone",
    "admin staff id",
  ]);
});

test("keeps local integration free of automatic seeds and fixed container names", async () => {
  const contents = await Promise.all(task3bIntegrationFiles.map(readRepositoryFile));
  const combined = contents.join("\n");
  const compose = contents[0];

  assert.doesNotMatch(combined, /seed-v2|seedDemoIdentity/u);
  assert.doesNotMatch(compose, /^\s*seed:\s*$/mu);
  assert.doesNotMatch(compose, /\bcontainer_name\s*:/u);
  assert.match(compose, /^\s*bootstrap:\s*$/mu);
  assert.match(compose, /^\s*profiles:\s*\[\s*"bootstrap"\s*\]\s*$/mu);
  assert.doesNotMatch(compose, /server:[\s\S]*?depends_on:[\s\S]*?\bbootstrap:/u);
});

test("makes Task 3B integration explicit and secret-driven", async () => {
  const compose = await readRepositoryFile("tools/compose/docker-compose.yml");
  const workflow = await readRepositoryFile(".github/workflows/v2-integration.yml");

  for (const name of [
    "LAUNDRY_ACCESS_TOKEN_SECRET",
    "LAUNDRY_CSRF_PROOF_SECRET",
    "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
    "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
  ]) {
    assert.match(compose, new RegExp(`${name}:\\s*["']?\\$\\{${name}:\\?`, "u"));
    assert.match(workflow, new RegExp(`${name}=`, "u"));
  }
  assert.match(compose, /LAUNDRY_CONTAINER_RUNTIME:\s*["']?1["']?/u);
  assert.match(workflow, /GITHUB_ENV/u);
  assert.match(workflow, /docker compose[^\n]*build/u);
  assert.equal((workflow.match(/run --rm migrate/gu) ?? []).length, 2);
  assert.equal((workflow.match(/run --rm bootstrap/gu) ?? []).length, 2);
  assert.match(workflow, /up -d server/u);
  assert.doesNotMatch(workflow, /set -x|echo\s+["']?\$\{?LAUNDRY_(?:ACCESS|CSRF|BOOTSTRAP)/u);
});

test("shares generic local login inputs across HTTP and browser smokes", async () => {
  const smoke = await readRepositoryFile("tools/compose/smoke-test.sh");
  const e2e = await readRepositoryFile("apps/web/e2e/local-login.spec.ts");
  const combined = `${smoke}\n${e2e}`;

  for (const name of [
    "LAUNDRY_LOCAL_ORG_CODE",
    "LAUNDRY_LOCAL_STORE_CODE",
    "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
    "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
  ]) {
    assert.match(smoke, new RegExp(name, "u"));
    assert.match(e2e, new RegExp(name, "u"));
  }
  assert.match(e2e, /\.fill\(/u);
  assert.doesNotMatch(combined, /hongfa|宏发|["']demo["']|店员甲|["']1234["']/iu);
  assert.doesNotMatch(smoke, /unexpected login response|login\s*=\s*["']?\$\(curl/u);
});

test("discovers the compose Postgres service instead of a fixed container name", async () => {
  for (const path of ["tools/compose/migrate-v2.sh", "tools/compose/smoke-rls.sh"]) {
    const source = await readRepositoryFile(path);

    assert.match(source, /docker compose/u, `${path} must use compose service discovery`);
    assert.match(source, /\bps\b[^\n]*-q[^\n]*postgres/u);
    assert.doesNotMatch(source, /laundry-postgres-v2/u);
  }
});

test("rejects production seed modules and non-test fixture importers", async () => {
  const files = await listRepositoryFiles("apps/server/src");
  const sources = new Map(
    await Promise.all(
      files
        .filter((path) => path.endsWith(".ts"))
        .map(async (path) => [path, await readRepositoryFile(path)]),
    ),
  );

  assert.deepEqual(findServerSeedBoundaryViolations(sources), []);
});

test("seed boundary gate catches legacy production paths and fixture imports", () => {
  const sample = new Map([
    ["apps/server/src/local/pg-seed.ts", "export const seedDemoIdentity = () => {};"],
    ["apps/server/src/local/runtime.ts", 'import "./pg-test-fixture.js";'],
  ]);

  assert.deepEqual(findServerSeedBoundaryViolations(sample), [
    "apps/server/src/local/pg-seed.ts: legacy production seed module",
    "apps/server/src/local/pg-seed.ts: seedDemoIdentity production reference",
    "apps/server/src/local/runtime.ts: test fixture imported outside *.test.ts",
  ]);
});
