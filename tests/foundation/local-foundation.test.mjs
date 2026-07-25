import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

async function readRepositoryFile(path) {
  return readFile(new URL(path, rootUrl), "utf8");
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

test("keeps product and credential defaults out of active V2 entry points", async () => {
  const activeEntries = [
    "apps/server/src/local/create-runtime.ts",
    "apps/server/src/http/main.ts",
    "apps/web/host/main.tsx",
    "apps/web/src/auth/HttpAuthClient.ts",
  ];
  const contents = await Promise.all(activeEntries.map(readRepositoryFile));

  for (const [index, content] of contents.entries()) {
    assert.doesNotMatch(
      content,
      /Hongfa Laundry|hongfa|宏发|password=demo/iu,
      `${activeEntries[index]} must stay generic`,
    );
  }

  for (const path of ["apps/server/src/http/main.ts", "apps/web/host/main.tsx"]) {
    const content = await readRepositoryFile(path);
    assert.doesNotMatch(
      content,
      /(?:password|PIN).*(?:DEMO_|demo|1234)/iu,
      `${path} must not print local credentials`,
    );
  }
});

test("centralizes generic local identity in the server profile module", async () => {
  const profile = await readRepositoryFile("apps/server/src/local/profile.ts");
  const consumers = await Promise.all(
    [
      "apps/server/src/local/create-runtime.ts",
      "apps/server/src/http/main.ts",
      "apps/web/host/main.tsx",
    ].map(readRepositoryFile),
  );

  assert.match(profile, /orgCode:\s*"local"/u);
  assert.match(profile, /storeCode:\s*"main"/u);
  assert.match(profile, /orgName:\s*"laundry-desk V2"/u);
  assert.match(profile, /storeName:\s*"本地门店"/u);
  assert.match(profile, /timezone:\s*"Asia\/Taipei"/u);

  for (const content of consumers) {
    assert.doesNotMatch(content, /org_code:\s*"local"|store_code:\s*"main"/u);
    assert.doesNotMatch(
      content,
      /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/u,
    );
  }
});
