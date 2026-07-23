# laundry-desk V2-only 升级版本实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 停止宏发 v1 单店版的一切后续功能开发，把现有 v1 仅作为迁移源与历史参考，集中完成可供宏发直接升级使用的 laundry-desk v2 柜台版本。

**Architecture:** 以 `origin/main` 现有 v2 monorepo 为唯一实现基线，沿用 ADR-12 的 Grok 单一技术负责人制度。升级版本采用 React SPA + Fastify + PostgreSQL/RLS + Local Edge Agent；人工、AI、自动化与离线回放共用 Command/Query Bus。v1 `src/` 在迁移验收前冻结保留，不再增加 M4/M5、SMS、UI 2.0 或独立 v1 release。

**Tech Stack:** Node.js 22、pnpm 11/Turborepo、TypeScript strict、Zod 4、Fastify 5、PostgreSQL 16、Drizzle、React 19、Electron 41、Vitest/Node Test、Playwright、GitHub Actions Windows/Linux。

---

## 0. 决策与范围

### 已确认决策

- 宏发 v1 单店版停止后续开发。
- 不再执行 v1 M4、v1 M5、`v0.1.0`–`v1.0.0` 收口发版路线。
- v1 代码、SQLite schema、历史测试只保留用于：
  1. `tools/migrate-v1` 数据迁移；
  2. 对照既有业务行为；
  3. 升级失败时的限期只读回退。
- 新功能、修复和交付门禁全部进入 v2 的 `apps/`、`packages/`、`tools/`。
- 腾讯云 SMS 不再落到 v1 M4；通知能力按 v2 M3 adapter 设计实现。
- v1 Liquid Glass M5 不再单独实施；可复用设计资产继续收敛到 `packages/ui`。

### 当前基线

- `main == origin/main == 8c152d5b8d149f1cb525b15339ed0f918cdeab79`
- `contracts@v0.1.0` 已存在，A1–A7 已冻结。
- v2 workspace format/lint/typecheck/test/build 当前全绿。
- 当前只有 `HERMES.md` 为未跟踪用户要求文件；执行计划时应纳入治理 PR。
- `origin/codex/fix-review-blockers` 比 main 少 #99、另有 6 个候选提交，且与 main 的 `0013_garment_photos.sql` 发生迁移编号冲突，禁止直接合并。

### 本轮交付目标：V2-M2 升级候选版

宏发可以用 v2 完成一整天营业：登录/PIN、开单、客户、部分取衣、付款/欠款、照片、统计、交班、三类打印、断网队列与恢复同步；v1 数据可只读迁移并得到零差异报告；只读 AI/BYOK 最小闭环可用。最终通过 Windows、PostgreSQL、迁移、离线与真机打印门禁。

### 明确不做

- 不继续修 v1 UI、v1 SMS、v1 权限或 v1 发版问题，除非它直接阻塞只读迁移。
- 不删除 `src/` 或历史 v1 文档；先冻结并标记 archived，待升级稳定期结束后另开清理 ADR。
- 不提前做 v2 M3 会员/通知写通道、M4 老板端、M5 自动化、M6 小程序/工厂/取送。
- 不把 mock/file spool/单测通过写成 Windows 或打印机实机通过。

## 1. 交付顺序与 PR 划分

| 顺序 | PR                  | 内容                                   | 前置          | 退出条件                            |
| ---: | ------------------- | -------------------------------------- | ------------- | ----------------------------------- |
|    1 | governance-v2-only  | ADR-13 + 全入口改为 V2-only            | 用户决策      | 当前入口不再声明 v1 继续开发        |
|    2 | review-blockers     | 从最新 main 重做候选修复               | PR 1          | 不回退 #99；migration 顺延 0014     |
|    3 | real-pg-integration | 真实 server+PG compose 与 CI           | PR 2          | PG 集成测试不再 skip                |
|    4 | contracts-v0.2      | M2 命令/查询/OpenAPI 冻结              | PR 3          | M2 契约快照确定且消费端可编译       |
|    5 | domain-m2           | 完整计价/付款/状态机                   | PR 4          | domain M2 纯函数 100% 行为覆盖      |
|    6 | server-db-m2        | M2 PG 生产路径与事务审计               | PR 5          | 生产 runtime 无关键 memory fallback |
|    7 | migrate-v1          | v1 SQLite→v2 PG 只读迁移               | PR 4/6 schema | 金额/件数/客户数差异均为 0          |
|    8 | edge-offline        | OS 密钥、SQLCipher、grant/lease/replay | PR 4/6        | 断网/重连闭环自动化通过             |
|    9 | printing-hardware   | 三打印族、串行写入、回执               | PR 2/8        | 代码门禁 + Windows 三机实测         |
|   10 | web-workday         | 柜台完整工作日 UI/E2E                  | PR 4/6        | real PG Playwright 核心路径绿       |
|   11 | readonly-ai         | BYOK 最小闭环和只读 AI                 | PR 4/6        | R0–R2 工具可用且写入红队为 0        |
|   12 | v2-upgrade-rc       | Windows 包、迁移演练、切换/回退        | PR 7–11       | 全门禁绿，生成升级候选包            |

每个 PR 都必须从最新 `origin/main` 建短分支，先观察对应测试红灯，再写最小实现；required checks 通过后才合并并复核 main。

---

### Task 1：记录 V2-only 产品决策并冻结 v1 功能线

**Objective:** 用新 ADR 覆盖“v1 收口与 v2 并行”的旧决策，使所有当前入口只指向 v2 升级路线，同时保留历史文档原文。

**Files:**

- Create: `docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md`
- Modify: `docs/adr/README.md`
- Modify: `README.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `HERMES.md`
- Modify: `AGENTS.md`
- Modify: `GROK.md`
- Modify: `CLAUDE.md`
- Modify: `GEMINI.md`
- Modify: `docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`
- Modify: `docs/superpowers/specs/2026-04-23-laundry-desk-design.md`（只加 archived/superseded 状态，不改历史正文）
- Modify: `docs/superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md`
- Modify: `docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md`
- Test: `tests/foundation/workspace.test.mjs`

**Step 1: 写失败的当前入口一致性测试**

在 `tests/foundation/workspace.test.mjs` 增加静态断言：

- `README.md`、`HERMES.md`、`AGENTS.md` 不再包含“v1 仍在进行/两条线并行/M4 ∥ M5”；
- 当前入口必须引用 ADR-13；
- `src/` 被描述为 frozen migration source，而不是功能开发线；
- 历史 spec/ADR 可保留旧文字，但必须有 archived/superseded 指针。

Run: `node --test tests/foundation/workspace.test.mjs`

Expected: FAIL，原因是当前 README/HERMES 仍声明 v1 双线继续。

**Step 2: 新增 ADR-13**

ADR 必须明确：

- 覆盖 ADR-07 第 5 点、总 RFC 的 v1 收口承诺、旧 v1 M4/M5 路线；
- 不覆盖 ADR-07 的 v1→v2 迁移要求；
- `src/` 冻结但暂不删除；
- v1 GitHub issues/milestones改为 Superseded/Archived；
- 下一客户版本直接来自 v2；公开 SemVer 在 RC 放行时确定。

**Step 3: 更新当前入口与路线图**

- README 首屏改为 v2 产品化升级说明；
- CHANGELOG 将 v1 部分标为 archived history；
- HERMES 只保留一条开发主线；
- v2 架构 §1 将兼容承诺改为“冻结 v1 功能、保留迁移与只读回退”；
- 当前任务书把全部后续工作指向 V2-M2。

**Step 4: 验证**

Run:

```bash
node --test tests/foundation/workspace.test.mjs
pnpm exec prettier --check README.md HERMES.md AGENTS.md GROK.md CLAUDE.md GEMINI.md docs/adr docs/CHANGELOG.md docs/superpowers/specs docs/superpowers/plans
pnpm run workspace:check
```

Expected: 全部 PASS。

**Step 5: GitHub 项目清理（ADR 合入后）**

- 在 v1 issue/milestone 留 ADR-13 链接后关闭为 superseded；
- 不删除历史 issue；
- 新建/更新 V2-M2 milestone，所有新开发项挂到该里程碑。

**Commit:** `docs(governance): stop v1 feature line and make v2 the only delivery path`

---

### Task 2：从最新 main 重做 review blockers，保护 #99

**Objective:** 吸收候选分支中仍有效的质量修复，但不直接合并过时分支、不删除 #99 功能、不产生重复 migration 号。

**Files:**

- Modify: `apps/server/src/order/list-handler.ts`
- Modify: `apps/server/src/order/pg-order-store.ts`
- Modify: `apps/server/src/order/types.ts`
- Modify: `apps/server/src/shift/pg-shift-store.ts`
- Modify: `apps/web/src/pages/OrdersList.tsx`
- Modify: `apps/web/src/pages/StatsPage.tsx`
- Modify: `apps/edge-agent/src/print/usb-port.ts`
- Modify: `apps/edge-agent/src/print/executor.ts`
- Create: `apps/edge-agent/src/print/execution-gate.ts`
- Create: `packages/db/src/migrations/0014_order_list_summary_indexes.sql`
- Modify: matching tests already present beside the files

**Step 1: 从 `origin/main` 建新分支，不 merge 候选分支**

只读取 `origin/codex/fix-review-blockers` 的测试意图和 diff。禁止把其删除 `photo`、`DebtPage`、`0013_garment_photos.sql` 的净变化带入。

**Step 2: 逐项导入失败测试**

先导入/重写以下行为测试并逐个观察失败：

1. PG 订单列表使用数据库聚合/分页，不全量读取后在 Node 聚合；
2. 营业日序列化统一为明确 UTC/business-date 规则；
3. PG shift close/get 真正持久化；
4. 打印设备路径、原始字节不经 preload/renderer 暴露；
5. 同一物理打印端口同时只执行一个 job。

Run targeted tests after each RED，例如：

```bash
pnpm --filter @laundry/server test
pnpm --filter @laundry/web test
pnpm --filter @laundry/edge-agent test
pnpm --filter @laundry/db test
```

Expected: 对应新增断言先失败。

**Step 3: 最小实现并逐项转绿**

- 索引 migration 使用 `0014`；
- 保留 main 的 `0013_garment_photos.sql`；
- 保留 #99 的照片、欠款、设置页与 Windows smoke 文档；
- 打印串行门只包物理 I/O，不把业务校验搬进 Edge。

**Step 4: 全量验证**

Run: `pnpm run workspace:check`

Expected: PASS，且 `git diff --name-status origin/main...HEAD` 不出现 #99 文件删除。

**Commit:** `fix(v2): reapply review blockers on top of latest main`

---

### Task 3：把真实 PostgreSQL/server 集成变成必过 CI

**Objective:** 淘汰 `tools/compose` 的 mock Cloud 主路径，让 server、migration、RLS、identity 和 M2 PG tests 在 CI 中真实运行且不得 skip。

**Files:**

- Create: `apps/server/Dockerfile`
- Modify: `tools/compose/docker-compose.yml`
- Modify: `tools/compose/migrate-v2.sh`
- Modify: `tools/compose/smoke-rls.sh`
- Modify: `tools/compose/smoke-test.sh`
- Modify: `tools/compose/README.md`
- Create: `.github/workflows/v2-integration.yml`
- Create: `apps/server/src/__tests__/migrations-pg-integration.test.ts`
- Create: `apps/server/src/__tests__/rls-pg-integration.test.ts`
- Modify: existing PG tests currently guarded by `LAUNDRY_USE_LOCAL_PG`

**Step 1: 写真实 PG 失败测试**

断言：

- migrations 可连续执行两次；
- `laundry_app` 不能绕过 RLS；
- 未设置/空 GUC 返回 0 行；
- rollback、pool reuse、worker 缺 GUC 均不串租户；
- audit 写失败时业务回滚；
- PG identity/order/print/shift/photo tests 在集成 job 中 `skipped === 0`。

Expected RED: 现有 compose 仍指向 mock server，photo PG store 不存在，若干 tests 会 skip。

**Step 2: 让 compose 启动真实服务**

服务至少包括：

- PostgreSQL 16；
- migration/seed one-shot；
- `apps/server`；
- 可选 mock printer only（明确标识，不冒充 Edge 实机）。

**Step 3: 新增 v2 integration workflow**

Linux CI 顺序：install → workspace check → compose up → migrate twice → seed twice → PG/RLS/security tests → local web E2E smoke → compose logs on failure → down -v。

**Step 4: 验证**

Run:

```bash
pnpm run workspace:check
docker compose -f tools/compose/docker-compose.yml up -d --build
bash tools/compose/migrate-v2.sh
bash tools/compose/migrate-v2.sh
bash tools/compose/smoke-rls.sh
bash tools/compose/smoke-test.sh
docker compose -f tools/compose/docker-compose.yml down -v
```

Expected: PASS；集成报告无 skipped PG gate。

**Commit:** `ci(v2): run real PostgreSQL and server integration gates`

---

### Task 4：冻结 contracts v0.2 与完整 M2 OpenAPI

**Objective:** 把当前 skeleton 命令升级为正式 M2 contract，先冻结所有 server/web/Edge 共同依赖的行为。

**Files:**

- Modify: `packages/contracts/src/commands/order.ts`
- Modify: `packages/contracts/src/commands/catalog.ts`
- Modify: `packages/contracts/src/commands/catalog-items.ts`
- Modify: `packages/contracts/src/commands/customer.ts`
- Modify: `packages/contracts/src/commands/print.ts`
- Modify: `packages/contracts/src/commands/stats.ts`
- Modify: `packages/contracts/src/commands/shift.ts`
- Modify: `packages/contracts/src/commands/photo.ts`
- Create: `packages/contracts/src/commands/payment.ts`
- Modify: `packages/contracts/src/openapi/build-document.ts`
- Modify: `packages/contracts/openapi/laundry-v2.openapi.json`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/m2-*.test.ts`

**Step 1: 每个命令先写 metadata/输入输出失败测试**

正式冻结范围：

- catalog 查询；
- customer 搜索/upsert/历史；
- order receive/get/list/hold/cancel/pickup；
- payment collect/repay/refund（退款在线 R4）；
- print enqueue/process/retry/reprint/list；
- stats day summary；
- shift close/get；
- photo register/list。

每项必须明确：risk、permission、offline mode、idempotency、PII classification、limits/redaction、统一信封。

**Step 2: 写离线与风险矩阵测试**

- receive：有效 offline grant 可排队；
- pickup/collect：仅 Primary lease；
- refund：online-only + R4 step-up；
- AI M2 投影只包含 R0–R2 queries；
- R5 永不进入 Tool Registry。

**Step 3: 实现 schema 并生成 OpenAPI**

生成两次必须零 diff，M2 定义不得继续标注“不在 OpenAPI freeze snapshot”。

**Step 4: 验证**

Run:

```bash
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/contracts build
git diff --exit-code packages/contracts/openapi/laundry-v2.openapi.json
```

Expected: PASS；contracts coverage ≥ 当前门禁；生成稳定。

**Commit:** `feat(contracts): freeze v0.2 counter and read-only AI APIs`

---

### Task 5：完成 M2 domain 不变量

**Objective:** 用纯函数统一计价、付款、订单/衣物状态和营业日口径，server/web 不重复业务算法。

**Files:**

- Modify: `packages/domain/src/order/pricing.ts`
- Modify: `packages/domain/src/order/payment.ts`
- Modify: `packages/domain/src/order/receive-plan.ts`
- Create: `packages/domain/src/order/cancel-plan.ts`
- Create: `packages/domain/src/order/hold-plan.ts`
- Create: `packages/domain/src/order/business-day.ts`
- Modify: `packages/domain/src/order/index.ts`
- Modify: `packages/domain/src/index.ts`
- Test: colocated `packages/domain/src/order/__tests__/*.test.ts`

**Step 1: 逐个垂直 TDD**

顺序：

1. 五段计价：原价→折价→附加→加急→运费→应收；
2. paid/debt/refund/reversal append-only ledger；
3. 部分取衣和订单关闭条件；
4. hold/resume/cancel 必填原因与回冲；
5. 门店时区营业日，不使用隐式宿主本地时区；
6. safe integer cents、溢出/负数 fail-closed。

每个测试先单独 RED→GREEN，再写下一个，不堆积测试。

**Step 2: 性质与边界测试**

- 金额永远为安全整数分；
- line qty 与 garments 数量一致；
- payment ledger 求和可重建余额；
- 订单只有全部衣物到终态且欠款为 0 才 closed；
- 票号唯一且永不复用，不承担时间排序。

**Step 3: 验证**

Run: `pnpm --filter @laundry/domain test && pnpm --filter @laundry/domain typecheck`

Expected: PASS；新增 M2 domain 行为 100% 覆盖。

**Commit:** `feat(domain): complete v2 counter pricing payment and lifecycle rules`

---

### Task 6：完成 M2 server/PG 生产路径

**Objective:** 让开单、取衣、付款、顾客、照片、统计、交班和打印全部在 PG/RLS/事务审计路径运行，生产模式不回退内存。

**Files:**

- Modify: `packages/db/src/schema/**`
- Create: sequential migrations after `0014`，禁止复用编号
- Modify: `packages/db/src/m2-tables.ts`
- Modify: `packages/db/src/rls.ts`
- Modify: `apps/server/src/order/pg-order-store.ts`
- Create: `apps/server/src/payment/pg-payment-store.ts`
- Create: `apps/server/src/photo/pg-photo-store.ts`
- Create: `apps/server/src/stats/pg-stats-source.ts`
- Modify: `apps/server/src/local/create-runtime.ts`
- Modify: `apps/server/src/handlers/register-m1.ts`（重命名留后续 PR，先只扩展注册）
- Test: corresponding `*.test.ts` and real PG integration tests

**Step 1: 写失败的生产 runtime 测试**

在 PG mode 断言：

- photo 不再实例化 `createMemoryPhotoStore()`；
- stats/order list 使用 SQL 聚合与分页；
- receive/pickup/payment/audit 共享同一 transaction；
- customer upsert 与 order receive 的一致性有明确事务边界；
- 所有表具备正确 tenant columns、RLS、组合键和索引；
- payment/audit append-only grants 拒绝 UPDATE/DELETE。

**Step 2: 按单一能力逐表/逐 store 实现**

每个 store 先用 fake client 做 SQL 形状测试，再用真实 PG 做行为测试。禁止把 org/store 从 command args 传入 repository；只使用认证 context/GUC。

**Step 3: 移除生产 memory fallback**

memory stores只保留单元测试/显式 demo mode。PG mode 缺 adapter 时启动失败，不静默退回内存。

**Step 4: 验证**

Run:

```bash
pnpm --filter @laundry/db test
pnpm --filter @laundry/server test
pnpm run workspace:check
# 再跑 Task 3 的 real PG integration gate
```

Expected: PASS；PG gate 无 skip；事务/审计/RLS 负向均绿。

**Commit:** `feat(server): complete transactional PostgreSQL counter runtime`

---

### Task 7：尽早完成 v1→v2 迁移器

**Objective:** 将冻结的 v1 SQLite 数据只读提取并安全迁入 v2 PG；这是停止 v1 后升级成功的关键路径，不得拖到最后。

**Files:**

- Create: `tools/migrate-v1/package.json`
- Create: `tools/migrate-v1/src/extract-v1.ts`
- Create: `tools/migrate-v1/src/transform.ts`
- Create: `tools/migrate-v1/src/load-v2.ts`
- Create: `tools/migrate-v1/src/reconcile.ts`
- Create: `tools/migrate-v1/src/cli.ts`
- Create: `tools/migrate-v1/test/fixtures/`（仅虚构数据）
- Create: `tools/migrate-v1/test/*.test.ts`
- Create: `tools/migrate-v1/README.md`
- Modify: `pnpm-workspace.yaml` only if current workspace glob does not already include `tools/*`

**Step 1: 写只读保证测试**

- v1 连接必须只读；
- 禁止向 source 发出 UPDATE/INSERT/DELETE/DDL；
- 输入数据库先复制到临时路径再读取；
- 日志不输出完整手机号/客户 PII。

**Step 2: 写转换失败测试**

- `order_items.qty=N` 生成 1 条 order_line + N 条 garment；
- 每件补唯一条码；
- customers/photos/settings 映射；
- 缺失日期按冻结规则补算；
- 金额保持整数分；
- 重复运行幂等。

**Step 3: 写 reconciliation 测试**

报告至少包含：订单数、衣物件数、客户数、应收金额、实收金额、欠款、照片数；任何非允许差异使进程退出非 0。

**Step 4: 实现 dry-run 与 load 两阶段 CLI**

默认 `--dry-run`；正式 `--apply` 需要显式目标库与确认参数，且先创建 v1 备份哈希和 v2 备份点。

**Step 5: 验证**

Run:

```bash
pnpm --filter @laundry/migrate-v1 test
pnpm --filter @laundry/migrate-v1 typecheck
pnpm --filter @laundry/migrate-v1 migrate -- --source test/fixtures/v1.db --target "$TEST_DATABASE_URL" --dry-run
```

Expected: PASS；fixture reconciliation 全 0。

**Commit:** `feat(migration): add read-only v1 to v2 migration and reconciliation`

---

### Task 8：Edge 生产化：OS 密钥、加密队列、grant/lease/replay

**Objective:** 把当前内存密文 skeleton 变成 Windows 可交付的离线执行端，并保持 Edge 无业务校验。

**Files:**

- Modify: `apps/edge-agent/src/pairing/device-keys.ts`
- Modify: `apps/edge-agent/src/queue/dek-kek.ts`
- Create: `apps/edge-agent/src/platform/windows-secret-store.ts`
- Create: `apps/edge-agent/src/queue/sqlcipher-store.ts`
- Create: `apps/edge-agent/src/lease/primary-lease.ts`
- Create: `apps/edge-agent/src/queue/replay.ts`
- Modify: `apps/edge-agent/src/ipc.ts`
- Modify: `apps/edge-agent/src/preload.ts`
- Create: server/db lease tables and handlers in corresponding `packages/db` / `apps/server` paths
- Modify: both lockfiles for any native dependency

**Step 1: 先做 SQLCipher/Windows native binding 兼容性测试**

在独立短 PR 验证 Node 22 + Electron 41 + Windows x64 安装、打开、错误密钥拒绝、打包后重开。没有真实验证前不选依赖，不把普通 SQLite+字段加密称为 SQLCipher。

**Step 2: OS secret store TDD**

测试设备私钥、KEK、wrapped DEK：

- 永不进入 renderer/preload/IPC/log；
- wrong user/machine 解密失败；
- clear/解绑擦除；
- 版本轮换可重包裹 DEK；
- CI 使用显式 fake adapter，生产缺 adapter fail-closed。

**Step 3: SQLCipher queue TDD**

覆盖 enqueue、重启恢复、tamper、顺序、幂等、容量限制、schema upgrade、队列未清空禁止升级。

**Step 4: offline grant + Primary lease TDD**

覆盖并发签发、旧主 release、等待到期、单调钟、重启/休眠 fail-closed、`lease_id+epoch+seq`、退款离线拒绝。

**Step 5: replay/integration**

断网开单/打印/Primary 取衣/收款 → 重连 → 当前 RBAC 与实体版本重校验 → 审计与同步报告；冲突进入仲裁而非静默覆盖。

**Step 6: 验证**

Run:

```bash
pnpm --filter @laundry/edge-agent test
pnpm --filter @laundry/edge-agent build
pnpm --filter @laundry/server test
pnpm run workspace:check
```

另需 Windows 实机冷启动、休眠、断网和重启证据。

**Commit:** `feat(edge): persist encrypted offline queue and primary lease safely`

---

### Task 9：完成三类打印生产闭环

**Objective:** 从 server `print_jobs` 到 Edge 签名验票、模板渲染、串行设备写入和回执对账，支持 XP-58、DL-206、GP-3120。

**Files:**

- Modify: `apps/edge-agent/src/print/executor.ts`
- Modify: `apps/edge-agent/src/print/usb-port.ts`
- Modify: `apps/edge-agent/src/print/escpos-xp58.ts`
- Create: `apps/edge-agent/src/print/tspl-dl206.ts`
- Create: `apps/edge-agent/src/print/tspl-gp3120.ts`
- Create: `apps/edge-agent/src/print/execution-gate.ts`
- Modify: `apps/server/src/print/**`
- Modify: `tools/lab/printers/CHECKLIST.md`
- Preserve: `apps/edge-agent/docs/printer-smoke-windows.md`

**Step 1: 从 M0 样张提取协议 golden tests**

每台覆盖 init、编码、全角 ￥、条码宽度、变量数、切刀/走纸、超长字段、空字段和非法模板拒绝。

**Step 2: 能力票据与回执测试**

- 无票据/过期/错误设备/错误 origin/重放全部拒绝；
- Edge 回执设备签名；
- server 只按 receipt 更新 job；
- 同设备串行，失败不阻塞后续重试。

**Step 3: 实现 drivers 与 Windows path adapter**

原始 path/bytes 不进入 renderer；`printer-smoke` 仅输出 status/bytes count。

**Step 4: 验证等级分开记录**

1. unit golden；
2. file spool；
3. Windows spool path；
4. 三台真实打印机样张。

只有第 4 级可标“实机通过”。

**Commit:** `feat(printing): complete signed three-printer execution pipeline`

---

### Task 10：完成柜台一整天 Web 工作流与 E2E

**Objective:** 让 Web SPA 只消费正式 contracts，在真实 server/PG/Edge 状态下完成整日营业，不依赖 mock client。

**Files:**

- Modify: `apps/web/src/commands/command-client.ts`
- Modify: `apps/web/src/commands/query-client.ts`
- Modify: `apps/web/src/pages/ReceivePage.tsx`
- Modify: `apps/web/src/pages/PickupPage.tsx`
- Modify: `apps/web/src/pages/CustomersPage.tsx`
- Modify: `apps/web/src/pages/OrdersList.tsx`
- Modify: `apps/web/src/pages/OrderDetailDrawer.tsx`
- Modify: `apps/web/src/pages/DebtPage.tsx`
- Modify: `apps/web/src/pages/StatsPage.tsx`
- Modify: `apps/web/src/pages/ShiftClosePanel.tsx`
- Create/Modify: focused colocated tests
- Create: `apps/web/e2e/v2-workday.spec.ts`
- Modify: `apps/web/playwright.local.config.ts`

**Step 1: 逐页写真实 API 失败测试**

禁止在 production host 未配置 `apiBaseUrl` 时静默使用 mock。测试登录后每个页面都通过 HTTP contracts client 请求真实 bus。

**Step 2: 逐个垂直切片**

顺序：登录/PIN → 开单 → 小票 → 客户 → 订单列表/详情 → 部分取衣/补款 → 欠款 → 照片 → 统计 → 交班。

每个切片先组件测试 RED，再最小 UI，再 real-PG Playwright。

**Step 3: 离线 UI**

显示 online/offline/pending/conflict；无 grant/lease 时按契约禁用对应动作并解释原因；不在浏览器保存交易真源。

**Step 4: 性能/可及性**

键盘熟手流开单脚本 ≤15 秒；状态色+形；reduced motion；金额只用 MoneyText；列表无逐行玻璃。

**Step 5: 验证**

Run:

```bash
pnpm --filter @laundry/web test
pnpm --filter @laundry/web typecheck
pnpm run local:web:e2e
```

Expected: PASS against real server/PG。

**Commit:** `feat(web): complete real-api counter workday workflow`

---

### Task 11：交付 M2 只读 AI/BYOK 最小闭环

**Objective:** 提供经营问答、订单/客户检索、操作导航草稿和规程助手，但 M2 AI 在任何输入下不得产生业务写入。

**Files:**

- Create: `apps/server/src/ai/providers/types.ts`
- Create: `apps/server/src/ai/providers/openai-compatible.ts`
- Create: `apps/server/src/ai/providers/anthropic.ts` or second provider selected by available key
- Create: `apps/server/src/ai/gateway.ts`
- Create: `apps/server/src/ai/byok-store.ts`
- Create: `apps/server/src/ai/stream.ts`
- Modify: `apps/server/src/tools/registry.ts`
- Create: AI key/usage DB migrations after current sequence
- Create: `apps/web/src/pages/AiDrawer.tsx`
- Test: provider contract, key leakage, red-team and read-only E2E

**Step 1: Tool Registry read-only test先红**

断言 M2 AI 投影只有 R0–R2 queries；任何 R3/R4/R5、command handler、raw SQL、任意 URL、文件系统或硬件接口不可见。

**Step 2: BYOK 安全测试**

- AES-256-GCM 独立 DEK、随机 nonce、AAD 绑定 org/provider/credential/version；
- key 不出现在响应、错误、日志、对话或备份；
- 保存后只返回 last4；
- official host allowlist；自定义 base URL 默认关闭。

**Step 3: Provider adapter contract tests**

用同一 tool loop 测 streaming、tool call、JSON/Zod、超时、限额与错误归一；真实 key 验证单独记录，mock 不可冒充实测。

**Step 4: Prompt injection 红队**

顾客姓名/备注/照片 OCR 中含指令时，不得产生写工具或越权查询；PII 默认打码。

**Step 5: 验证**

Run server/web tests and a real-key compatibility matrix when keys are available。

**Commit:** `feat(ai): add secure byok read-only operator for m2`

---

### Task 12：V2 升级候选版、迁移演练与宏发切换

**Objective:** 生成可安装、可迁移、可回退的 Windows 升级候选版本，并用真实宏发只读副本与设备完成门禁。

**Files:**

- Modify: `apps/edge-agent/package.json`
- Create/Modify: Edge electron-builder config and signed SPA packaging files
- Create: `.github/workflows/v2-windows-release.yml`
- Create: `docs/release/v2-upgrade-runbook.md`
- Create: `docs/release/v2-m2-gate-report.md`
- Modify: `docs/CHANGELOG.md`
- Modify: `README.md`

**Step 1: Windows 包与断网冷启动测试**

安装包内置签名 last-known-good SPA；`app://` 校验失败拒绝启动业务 UI；无网重启仍可进入离线工作台。

**Step 2: 升级状态机测试**

队列未清空禁止升级；本地库快照；A/B 槽；健康检查；只有支持矩阵允许时才回滚，否则恢复模式前滚修复。

**Step 3: 宏发迁移演练**

对 v1 数据库只读副本执行：备份/哈希 → dry-run → PG 影子库 load → reconciliation → 操作员抽查 → 清库重跑。未取得正式授权不得读取真实 PII。

**Step 4: 一整天/断网/打印门禁**

- 开单 ≤15 秒；
- 部分取衣和欠款正确；
- 三打印机真实样张；
- 拔网线后开单、打印、Primary 取衣/收款；
- 重连无重复入账并生成同步报告；
- Windows 10/11 实机；
- v2 integration、foundation、Windows release 三 workflow 同 SHA 绿。

**Step 5: 切换与回退**

- 切换窗口前冻结 v1 写入并最终备份；
- 正式迁移并再次 reconciliation；
- v1 仅保留只读回退，不再接受新单；
- 回退条件、数据仲裁和截止日期写入 runbook；
- 稳定期后另开 ADR 决定是否移除根 v1 runtime。

**Step 6: 发布**

SemVer 在门禁报告签署时确定；建议先发 upgrade beta/RC，不复用旧 v1 `v0.x` tag。附安装器、SHA256、迁移报告、支持矩阵和已知限制。

**Commit:** `release(v2): prepare upgrade candidate and migration runbook`

---

## 2. 固定验证矩阵

每个代码 PR：

```bash
pnpm run workspace:check
pnpm run lint
pnpm run typecheck
```

按范围增加：

- contracts：snapshot + coverage；
- db/server：真实 PG migrations/RLS/audit/identity；
- web：Playwright real API；
- Edge：Windows package + offline/upgrade；
- printing：三机实测；
- AI：真实 key matrix + injection red team；
- migration：fixture + 宏发只读副本 reconciliation。

任何外部依赖未满足时，报告必须写“代码侧通过/待实测”，不得降低门禁或伪造证据。

## 3. 外部条件与默认选择

- **宏发 v1 SQLite 副本**：只读、先脱敏 fixture；真实副本需 manpengan 授权。
- **Windows 与三打印机**：XP-58、DASCOM DL-206、Gprinter GP-3120。
- **模型 key**：至少一款国内可达 provider + 一款第二协议 provider。
- **生产部署默认**：云端 server/managed PostgreSQL + 柜台 Edge；本地 compose 只作为开发/自托管验证。若改为宏发现场自托管，应在 Task 12 前新增部署 ADR。
- **微信/SMS 资质**：不阻塞 V2-M2；进入正式 V2-M3 前再准备。

## 4. 下一步立即执行的三个 PR

1. **PR 1 — governance-v2-only**：ADR-13、README/CHANGELOG/HERMES/任务书更新，明确 v1 frozen。
2. **PR 2 — review-blockers**：从最新 main 重做 6 个候选修复，保留 #99，migration 改 `0014`。
3. **PR 3 — real-pg-integration**：真实 server+PG compose、无 skip 集成 CI。

这三个 PR 完成后，才进入 contracts v0.2 → domain → server/PG 的正式 M2 功能链；Edge/Web 可在 contracts v0.2 冻结后并行推进，但最终门禁必须汇合到同一 main SHA。
