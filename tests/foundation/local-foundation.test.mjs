import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const rootUrl = new URL("../../", import.meta.url);
const execFileAsync = promisify(execFile);
const governanceFiles = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GROK.md",
  "GEMINI.md",
  "HERMES.md",
];
const currentDeliveryAdr = "(docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)";
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

test("routes every governance entry point to ADR-37", async () => {
  const contents = await Promise.all(governanceFiles.map(readRepositoryFile));
  const missingLinks = governanceFiles.filter(
    (_file, index) => !contents[index].includes(currentDeliveryAdr),
  );

  assert.deepEqual(missingLinks, []);
});

test("leads the README with the generic v2 hk-vps cloud-test route", async () => {
  const readmeLead = (await readRepositoryFile("README.md")).slice(0, 1500);

  assert.match(readmeLead, /通用 V2.*hk-vps.*Linux Web Server\/Web.*桌面 App/su);
});

test("does not advertise stale Hongfa or Grok delivery ownership in the README lead", async () => {
  const readmeLead = (await readRepositoryFile("README.md")).slice(0, 1500);

  assert.doesNotMatch(readmeLead, /宏发升级候选版|Grok 单一技术负责人/u);
});

test("records the active V2 file size policy", async () => {
  const agentGuidance = await readRepositoryFile("AGENTS.md");

  assert.match(agentGuidance, /活动 V2 生产 JS\/TS 文件[^。\n]*默认[^。\n]*400 physical lines/u);
  assert.match(agentGuidance, /测试文件[^。\n]*800 physical lines[^。\n]*硬上限/u);
  assert.match(agentGuidance, /15 个命名冻结预算[^。\n]*不得增长/u);
  assert.ok(
    agentGuidance.includes("(docs/superpowers/specs/2026-07-27-file-size-quality-gate-design.md)"),
  );
});

test("keeps the deferred Windows release workflow manual", async () => {
  const workflow = await readRepositoryFile(".github/workflows/build.yml");

  assert.match(workflow, /^name: Build\/Release$/mu);
  assert.match(workflow, /^  workflow_dispatch:$/mu);
  assert.doesNotMatch(workflow, /^  (?:push|pull_request):/mu);
});

test("pins JavaScript actions to Node 24 compatible stable majors", async () => {
  const [buildWorkflow, foundationWorkflow, integrationWorkflow] = await Promise.all(
    [
      ".github/workflows/build.yml",
      ".github/workflows/foundation.yml",
      ".github/workflows/v2-integration.yml",
    ].map(readRepositoryFile),
  );

  for (const workflow of [buildWorkflow, foundationWorkflow, integrationWorkflow]) {
    assert.match(workflow, /uses: actions\/checkout@v7/u);
    assert.match(workflow, /uses: actions\/setup-node@v7/u);
    assert.doesNotMatch(
      workflow,
      /uses: (?:actions\/(?:checkout|setup-node|upload-artifact)|pnpm\/action-setup)@v4/u,
    );
  }
  for (const workflow of [buildWorkflow, integrationWorkflow]) {
    assert.match(workflow, /uses: actions\/upload-artifact@v7/u);
  }
  for (const workflow of [foundationWorkflow, integrationWorkflow]) {
    assert.match(workflow, /uses: pnpm\/action-setup@v6/u);
    assert.match(workflow, /node-version: 22/u);
  }
  assert.match(buildWorkflow, /node-version: 20/u);
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
    "node --test tools/local/*.test.mjs tools/runtime-kit/*.test.mjs tests/foundation/*.test.mjs && turbo run test",
  );
});

test("uses the generic V2 display name in active packaging metadata", async () => {
  const rootPackage = JSON.parse(await readRepositoryFile("package.json"));

  assert.equal(rootPackage.build.productName, "laundry-desk V2");
  assert.equal(rootPackage.build.nsis.shortcutName, "laundry-desk V2");
});

test("pins Electron and keeps its install lifecycle explicit", async () => {
  const [rootPackageSource, edgePackageSource, workspaceSource] = await Promise.all([
    readRepositoryFile("package.json"),
    readRepositoryFile("apps/edge-agent/package.json"),
    readRepositoryFile("pnpm-workspace.yaml"),
  ]);
  const rootPackage = JSON.parse(rootPackageSource);
  const edgePackage = JSON.parse(edgePackageSource);

  assert.equal(rootPackage.devDependencies.electron, "41.10.3");
  assert.equal(edgePackage.devDependencies.electron, "41.10.3");
  assert.equal(rootPackage.devDependencies["electron-builder"], "26.15.3");
  assert.match(workspaceSource, /^\s{2}"?@google\/genai"?: false$/mu);
  assert.match(workspaceSource, /^\s{2}electron: true$/mu);
  assert.match(workspaceSource, /^\s{2}electron-winstaller: false$/mu);
  assert.equal(rootPackage.scripts.postinstall, undefined);
  assert.equal(rootPackage.scripts["rebuild:app-deps"], "electron-builder install-app-deps");
});

test("keeps HTTP server composition independent from ambient PG signing aliases", async () => {
  const [serverEntry, lifecycle] = await Promise.all([
    readRepositoryFile("apps/server/src/http/main.ts"),
    readRepositoryFile("apps/server/src/http/server-lifecycle.ts"),
  ]);

  assert.match(serverEntry, /startLocalHttpServer/u);
  assert.match(lifecycle, /parseLocalHostConfig/u);
  assert.doesNotMatch(`${serverEntry}\n${lifecycle}`, /parseLocalServerConfig/u);
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
  const commissioningPgAcceptance = await readRepositoryFile(
    "tools/local/commissioning-pg-acceptance.mjs",
  );
  const freshCommissioningAcceptance = await readRepositoryFile(
    "tools/local/commissioning-acceptance.mjs",
  );

  assert.doesNotMatch(workflow, /^\s*-\s+name:\s+Start local Vite Web host\s*$/mu);
  assert.match(workflow, /^\s*-\s+name:\s+Run Playwright against real server and PostgreSQL\s*$/mu);
  for (const name of ["LAUNDRY_ACCESS_TOKEN_SECRET", "LAUNDRY_CSRF_PROOF_SECRET"]) {
    assert.match(compose, new RegExp(`${name}:\\s*["']?\\$\\{${name}-\\}`, "u"));
  }
  assert.match(workflow, /ensureLocalConfig/u);
  for (const field of [
    "postgresSuperuserPassword",
    "postgresAppPassword",
    "accessTokenSecret",
    "csrfProofSecret",
  ]) {
    assert.match(workflow, new RegExp(field, "u"));
  }
  for (const name of [
    "LAUNDRY_BOOTSTRAP_ADMIN_USERNAME",
    "LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME",
    "LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD",
    "LAUNDRY_BOOTSTRAP_ADMIN_PIN",
    "LAUNDRY_BOOTSTRAP_APPROVER_USERNAME",
    "LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME",
    "LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD",
    "LAUNDRY_BOOTSTRAP_APPROVER_PIN",
  ]) {
    assert.doesNotMatch(compose, new RegExp(`${name}:`, "u"));
    assert.match(workflow, new RegExp(`${name}=`, "u"));
  }
  assert.match(compose, /LAUNDRY_CONTAINER_RUNTIME:\s*["']?1["']?/u);
  assert.match(
    compose,
    /LAUNDRY_NOTIFICATION_PROVIDER_MODE:\s*["']?\$\{LAUNDRY_NOTIFICATION_PROVIDER_MODE-disabled\}["']?/u,
  );
  assert.equal([...workflow.matchAll(/pnpm local:up -- --bootstrap/gu)].length, 7);
  assert.match(workflow, /pnpm local:web:commissioning:e2e/u);
  assert.match(
    workflow,
    /name: Run Playwright against real server and PostgreSQL[\s\S]{0,160}LAUNDRY_NOTIFICATION_PROVIDER_MODE:\s*["']software_only["'][\s\S]{0,160}pnpm local:up -- --bootstrap[\s\S]{0,120}pnpm run local:web:e2e/u,
  );
  assert.match(workflow, /commissioning-pg-acceptance\.mjs/u);
  assert.match(freshCommissioningAcceptance, /"--filter", "@laundry\/server\.\.\."/u);
  assert.match(freshCommissioningAcceptance, /delivery-policy-pg-acceptance\.mjs/u);
  assert.match(freshCommissioningAcceptance, /member-benefits-pg-acceptance\.mjs/u);
  assert.match(freshCommissioningAcceptance, /notification-delivery-pg-acceptance\.mjs/u);
  assert.match(freshCommissioningAcceptance, /factory-handoff-pg-acceptance\.mjs/u);
  assert.match(freshCommissioningAcceptance, /hk-vps-release-catalog-pg-acceptance\.mjs/u);
  assert.match(freshCommissioningAcceptance, /hk-vps-data-protection-pg-acceptance\.mjs/u);
  assert.match(
    freshCommissioningAcceptance,
    /hk-vps-data-protection-pg-acceptance\.mjs[\s\S]{0,240}LAUNDRY_COMMISSIONING_ACCEPTANCE_ISOLATED:\s*"1"/u,
  );
  assert.match(freshCommissioningAcceptance, /"member-benefits\.spec\.ts"/u);
  assert.match(freshCommissioningAcceptance, /"customer-profile\.spec\.ts"/u);
  assert.match(freshCommissioningAcceptance, /"notification-delivery\.spec\.ts"/u);
  assert.match(freshCommissioningAcceptance, /"factory-handoff\.spec\.ts"/u);
  assert.match(
    freshCommissioningAcceptance,
    /mode === "browser"[\s\S]{0,160}LAUNDRY_NOTIFICATION_PROVIDER_MODE:\s*"software_only"/u,
  );
  assert.match(workflow, /commissioning_project=.*GITHUB_RUN_ID/u);
  assert.match(workflow, /::add-mask::/u);
  assert.match(workflow, /POSTGRES_PASSWORD:\s*config\.postgresSuperuserPassword/u);
  assert.match(workflow, /LAUNDRY_APP_PASSWORD:\s*config\.postgresAppPassword/u);
  assert.doesNotMatch(workflow, /docker compose[^\n]*run[^\n]*(?:migrate|bootstrap)/u);
  assert.doesNotMatch(workflow, /set -x|echo\s+["']?\$\{?LAUNDRY_(?:ACCESS|CSRF|BOOTSTRAP)/u);
  assert.match(
    commissioningPgAcceptance,
    /DELETE FROM public\.laundry_schema_migrations WHERE filename = \$1[\s\S]*0045_store_commissioning_staff_credentials\.sql/u,
  );
  assert.match(
    commissioningPgAcceptance,
    /assert\.equal\(migrations\.head, "0056_delivery_orders\.sql"\)/u,
  );
});

test("keeps the recovery-set CI shell block syntactically valid", async () => {
  const workflow = await readRepositoryFile(".github/workflows/v2-integration.yml");
  const start = workflow.indexOf("      - name: Create and restore-drill a private recovery set");
  const end = workflow.indexOf(
    "      - name: Run server tests against real PostgreSQL with no skips",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const section = workflow.slice(start, end);
  const runMarker = "        run: |\n";
  const runStart = section.indexOf(runMarker);
  assert.ok(runStart >= 0);
  const script = section
    .slice(runStart + runMarker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  await execFileAsync("bash", ["-n", "-c", script]);
  assert.match(script, /^umask 077$/mu);
  assert.match(script, /^trap 'rm -f -- "\$\{recovery_metadata\}"' EXIT$/mu);
});

test("uses generated local database secrets and loopback-only Compose ports", async () => {
  const compose = await readRepositoryFile("tools/compose/docker-compose.yml");
  const bootstrapRoles = await readRepositoryFile("tools/compose/bootstrap-roles.sh");
  const migrate = await readRepositoryFile("tools/compose/migrate-v2.sh");
  const smoke = await readRepositoryFile("tools/compose/smoke-rls.sh");
  const pgPool = await readRepositoryFile("apps/server/src/db/pg-pool.ts");
  const composeEntries = await readdir(new URL("tools/compose/", rootUrl), {
    withFileTypes: true,
  });

  assert.match(compose, /["']127\.0\.0\.1:8543:5432["']/u);
  assert.match(compose, /["']127\.0\.0\.1:8787:8787["']/u);
  assert.match(compose, /com\.laundry-desk\.managed:\s*["']true["']/u);
  assert.match(compose, /com\.laundry-desk\.project:/u);
  assert.match(compose, /com\.laundry-desk\.instance:\s*["']\$\{LAUNDRY_LOCAL_INSTANCE_ID-\}["']/u);
  assert.match(compose, /bootstrap-roles\.sh/u);
  assert.doesNotMatch(compose, /bootstrap\.sql|init\.sql/u);
  assert.doesNotMatch(compose, /\b(?:sh|bash)\s+-c\b/u);
  assert.deepEqual(
    composeEntries
      .filter((entry) => entry.name === "bootstrap.sql" || entry.name === "init.sql")
      .map((entry) => entry.name),
    [],
  );
  assert.equal(
    composeEntries.some((entry) => entry.isDirectory() && entry.name === "mock-server"),
    false,
  );

  const activeSources = [compose, bootstrapRoles, migrate, smoke, pgPool].join("\n");
  assert.doesNotMatch(activeSources, /app_secure_password|postgres_secure_password/u);
  assert.doesNotMatch(
    activeSources,
    /postgres(?:ql)?:\/\/[^$\s]+:[^${}\s@]+@(?:postgres|127\.0\.0\.1)/u,
  );

  assert.match(bootstrapRoles, /\\prompt\s+['"]{2}\s+app_password/u);
  assert.match(bootstrapRoles, /\\prompt[\s\S]*?\bBEGIN;[\s\S]*?\bCOMMIT;/u);
  assert.match(bootstrapRoles, /format\([\s\S]*?%L[\s\S]*?:'app_password'/u);
  assert.doesNotMatch(bootstrapRoles, /(?:--set|-v)\s+app_password=/u);
  assert.match(migrate, /\bPGPASSFILE\b/u);
  assert.match(migrate, /\bchmod\s+600\b/u);
  assert.match(migrate, /pg_advisory_xact_lock/u);
  assert.match(migrate, /\\if\s+:migration_exists/u);
  assert.match(migrate, /SELECT\s+1\s*\/\s*0\s+AS\s+checksum_mismatch/u);
  assert.doesNotMatch(migrate, /\\quit\b/u);
  assert.doesNotMatch(migrate, /\bpsql\s+["']?\$\{SUPERUSER_DATABASE_URL\}/u);
  assert.doesNotMatch(migrate, /docker\s+exec[\s\S]{0,160}-e\s+PGPASSWORD/u);
});

test("registers the guarded local lifecycle in default workspace gates", async () => {
  const rootPackage = JSON.parse(await readRepositoryFile("package.json"));

  assert.equal(rootPackage.scripts["local:up"], "node tools/local/up.mjs");
  assert.equal(rootPackage.scripts["local:down"], "node tools/local/down.mjs");
  assert.equal(rootPackage.scripts["local:reset"], "node tools/local/reset.mjs");
  assert.equal(rootPackage.scripts["local:lan:onboard"], "node tools/local/lan-onboard.mjs");
  assert.equal(rootPackage.scripts["local:lan:diagnose"], "node tools/local/lan-diagnose.mjs");
  assert.match(rootPackage.scripts["workspace:test"], /tools\/local\/\*\.test\.mjs/u);
  assert.match(rootPackage.scripts["workspace:format:check"], /tools\/local/u);
  assert.match(rootPackage.scripts["workspace:format:check"], /tools\/compose/u);
  assert.match(
    rootPackage.scripts["workspace:lint"],
    /eslint tools\/cloud --ext \.mjs --max-warnings=0/u,
  );
  assert.match(
    rootPackage.scripts["workspace:lint"],
    /eslint tools\/local tools\/release-candidate tests\/foundation tools\/runtime-kit\/\*\.mjs --ext \.mjs/u,
  );
});

test("keeps browser and Electron acceptance sources inside canonical quality gates", async () => {
  const edgePackage = JSON.parse(await readRepositoryFile("apps/edge-agent/package.json"));
  const webPackage = JSON.parse(await readRepositoryFile("apps/web/package.json"));
  const edgeE2eConfig = JSON.parse(await readRepositoryFile("apps/edge-agent/tsconfig.e2e.json"));
  const webE2eConfig = JSON.parse(await readRepositoryFile("apps/web/tsconfig.e2e.json"));

  assert.equal(edgePackage.scripts.lint, "eslint . --ext .ts,.tsx,.mjs --max-warnings=0");
  assert.match(edgePackage.scripts.typecheck, /tsconfig\.e2e\.json/u);
  assert.deepEqual(edgeE2eConfig.include, [
    "e2e/**/*.ts",
    "playwright.electron.commissioning.config.ts",
    "playwright.electron.config.ts",
  ]);

  assert.equal(webPackage.scripts.lint, "eslint . --ext .ts,.tsx,.mjs --max-warnings=0");
  assert.match(webPackage.scripts.typecheck, /tsconfig\.e2e\.json/u);
  assert.deepEqual(webE2eConfig.include, [
    "e2e/**/*.ts",
    "e2e-commissioning/**/*.ts",
    "e2e-lan/**/*.ts",
    "playwright.cloud.config.ts",
    "playwright.commissioning.config.ts",
    "playwright.local.config.ts",
    "playwright.lan.config.ts",
  ]);
});

test("rejects undefined globals in Cloud release and browser JavaScript", async () => {
  const eslintConfig = (await import(new URL("../../.eslintrc.cjs", import.meta.url))).default;
  const cloudOverride = eslintConfig.overrides.find(
    (override) =>
      override.files.includes("tools/cloud/**/*.mjs") &&
      override.files.includes("apps/web/e2e-cloud/**/*.mjs"),
  );

  assert.equal(cloudOverride?.env?.es2021, true);
  assert.equal(cloudOverride?.env?.node, true);
  assert.equal(cloudOverride?.rules?.["no-undef"], "error");
});

test("serializes server test files that mutate shared PostgreSQL roles", async () => {
  const serverPackage = JSON.parse(await readRepositoryFile("apps/server/package.json"));
  assert.match(serverPackage.scripts?.test ?? "", /--test-concurrency=1/u);
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

test("keeps RLS smoke database passwords out of process arguments", async () => {
  const smoke = await readRepositoryFile("tools/compose/smoke-rls.sh");

  assert.match(smoke, /\bPGPASSFILE\b/u);
  assert.match(smoke, /\bchmod\s+600\b/u);
  assert.match(
    smoke,
    /unset[\s\S]*?LAUNDRY_APP_PASSWORD[\s\S]*?POSTGRES_PASSWORD[\s\S]*?DATABASE_URL[\s\S]*?DATABASE_ADMIN_URL[\s\S]*?SUPERUSER_DATABASE_URL[\s\S]*?LAUNDRY_PG_APP_URL[\s\S]*?PGPASSWORD[\s\S]*?PGPASSFILE/u,
  );
  assert.doesNotMatch(smoke, /\bpsql\s+["']?\$\{(?:APP|ADMIN)_DATABASE_URL\}/u);
  assert.doesNotMatch(smoke, /docker\s+exec[\s\S]{0,160}-e\s+PGPASSWORD/u);
  assert.match(smoke, /CREATE\s+TEMP(?:ORARY)?\s+TABLE/u);
});

test("rejects non-loopback smoke targets before loading or sending credentials", async () => {
  const rlsSmokePath = fileURLToPath(new URL("tools/compose/smoke-rls.sh", rootUrl));
  const httpSmokePath = fileURLToPath(new URL("tools/compose/smoke-test.sh", rootUrl));
  const rlsSmoke = await readFile(rlsSmokePath, "utf8");
  const httpSmoke = await readFile(httpSmokePath, "utf8");
  const playwrightConfig = await readRepositoryFile("apps/web/playwright.local.config.ts");
  const playwrightSmoke = await readRepositoryFile("apps/web/e2e/local-login.spec.ts");

  assert.ok(rlsSmoke.indexOf("validate_local_target\n\nAPP_PASSWORD_VALUE=") > 0);
  assert.match(rlsSmoke, /\[\[ "\$\{PGHOST\}" == "127\.0\.0\.1" \]\]/u);
  assert.match(rlsSmoke, /\[\[ "\$\{PGPORT\}" == "8543" \]\]/u);
  assert.ok(
    httpSmoke.indexOf('[[ "${SERVER_URL}" == "http://127.0.0.1:8787" ]]') <
      httpSmoke.indexOf('LAUNDRY_SMOKE_ADMIN_PASSWORD="${LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD}"'),
  );
  assert.equal([...httpSmoke.matchAll(/--noproxy '\*'/gu)].length, 3);
  assert.match(playwrightConfig, /configuredWebUrl !== LOCAL_WEB_URL/u);
  assert.match(playwrightSmoke, /exactLocalUrl\("LAUNDRY_API_URL"/u);

  for (const [environment, expectedError] of [
    [{ PGHOST: "database.example.invalid" }, /PGHOST must be local loopback/u],
    [{ PGHOST: "127.0.0.1", PGHOSTADDR: "203.0.113.40" }, /PGHOSTADDR must not override/u],
    [{ PGHOST: "127.0.0.1", PGSERVICE: "redirected" }, /PGSERVICE must not override/u],
    [
      { PGHOST: "127.0.0.1", PGSERVICEFILE: "/tmp/redirect.conf" },
      /PGSERVICEFILE must not override/u,
    ],
  ]) {
    await assert.rejects(
      execFileAsync("/bin/bash", [rlsSmokePath], {
        env: {
          ...process.env,
          ...environment,
          LAUNDRY_APP_PASSWORD: "must-not-be-sent",
          POSTGRES_PASSWORD: "must-not-be-sent",
        },
      }),
      (error) => {
        assert.match(error.stderr, expectedError);
        assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /must-not-be-sent/u);
        return true;
      },
    );
  }

  await assert.rejects(
    execFileAsync("/bin/bash", [httpSmokePath], {
      env: {
        ...process.env,
        LAUNDRY_SERVER_URL: "https://server.example.invalid",
        LAUNDRY_LOCAL_ORG_CODE: "local",
        LAUNDRY_LOCAL_STORE_CODE: "main",
        LAUNDRY_BOOTSTRAP_ADMIN_USERNAME: "admin",
        LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "must-not-be-sent",
      },
    }),
    (error) => {
      assert.match(error.stderr, /server URL must be the local loopback endpoint/u);
      assert.doesNotMatch(`${error.stdout}\n${error.stderr}`, /must-not-be-sent/u);
      return true;
    },
  );
});

test("scrubs inherited database secrets before invoking RLS smoke subprocesses", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "laundry-smoke-env-"));
  const fakePsql = join(fixtureDirectory, "psql");
  const fakeChmod = join(fixtureDirectory, "chmod");
  const smokeScript = fileURLToPath(new URL("tools/compose/smoke-rls.sh", rootUrl));

  try {
    await writeFile(
      fakePsql,
      `#!/usr/bin/env bash
set -euo pipefail
if env | grep -Eq '^(LAUNDRY_APP_PASSWORD|POSTGRES_PASSWORD|DATABASE_URL|SUPERUSER_DATABASE_URL|PGPASSWORD|PGHOSTADDR|PGSERVICE|PGSERVICEFILE|LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD|LAUNDRY_BOOTSTRAP_ADMIN_PIN|LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD|LAUNDRY_BOOTSTRAP_APPROVER_PIN|LAUNDRY_ACCESS_TOKEN_SECRET|LAUNDRY_CSRF_PROOF_SECRET|APP_PASSWORD_VALUE|ADMIN_PASSWORD_VALUE)='; then
  exit 91
fi
if env | grep -Fq 'exported-app-secret'; then
  exit 92
fi
[[ -n "\${PGPASSFILE:-}" && -f "\${PGPASSFILE}" ]]
printf 'sanitized-subprocess\\n'
`,
    );
    await writeFile(
      fakeChmod,
      `#!/usr/bin/env bash
set -euo pipefail
if env | grep -Fq 'exported-app-secret'; then
  exit 93
fi
exec /bin/chmod "$@"
`,
    );
    await chmod(fakePsql, 0o700);
    await chmod(fakeChmod, 0o700);

    const result = await execFileAsync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; run_host_psql "$LAUNDRY_APP_USER" "$APP_PASSWORD_VALUE" -c "SELECT 1"',
        "_",
        smokeScript,
      ],
      {
        env: {
          ...process.env,
          PATH: `${fixtureDirectory}:${process.env.PATH ?? ""}`,
          TMPDIR: fixtureDirectory,
          LAUNDRY_APP_PASSWORD: "exported-app-secret",
          POSTGRES_PASSWORD: "exported-admin-secret",
          DATABASE_URL: "postgres://exported-app-url",
          SUPERUSER_DATABASE_URL: "postgres://exported-admin-url",
          PGPASSWORD: "exported-libpq-secret",
          PGHOSTADDR: "",
          PGSERVICE: "",
          PGSERVICEFILE: "",
          LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD: "exported-bootstrap-secret",
          LAUNDRY_BOOTSTRAP_ADMIN_PIN: "482915",
          LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD: "exported-approver-secret",
          LAUNDRY_BOOTSTRAP_APPROVER_PIN: "739251",
          LAUNDRY_ACCESS_TOKEN_SECRET: "exported-access-secret",
          LAUNDRY_CSRF_PROOF_SECRET: "exported-csrf-secret",
          password: "preexisting-exported-password",
          escaped_password: "preexisting-exported-escaped-password",
        },
      },
    );

    assert.equal(result.stdout.trim(), "sanitized-subprocess");
    assert.deepEqual((await readdir(fixtureDirectory)).sort(), ["chmod", "psql"]);
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test("rejects multiline pgpass fields before creating a credential file", async () => {
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "laundry-smoke-pgpass-"));
  const smokeScript = fileURLToPath(new URL("tools/compose/smoke-rls.sh", rootUrl));

  try {
    await assert.rejects(
      execFileAsync(
        "/bin/bash",
        [
          "-c",
          'source "$1"; create_pgpass_file "$2" 5432 laundry_app app_secret',
          "_",
          smokeScript,
          "host\ninjection",
        ],
        {
          env: {
            ...process.env,
            TMPDIR: fixtureDirectory,
          },
        },
      ),
    );
    assert.deepEqual(await readdir(fixtureDirectory), []);
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
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
