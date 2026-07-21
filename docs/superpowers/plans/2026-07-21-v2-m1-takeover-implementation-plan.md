# laundry-desk v2 M1 接管实施计划

> **执行者要求：** 按独立 worktree 与单能力 PR 执行；每项先写失败测试并确认红灯，再写最小实现。
> **目标：** 在不推倒已合入资产的前提下，闭合 contracts → PG/RLS → Command Bus/Audit → Identity/Policy → Edge/Web → 迁移与门禁的 M1 纵向链。
> **架构：** Codex 单一负责核心设计与实现；Grok 只实现冻结 ports/contracts 后的平台 adapters、Web/UI 和实机验证。正式 PG schema 独立为 `packages/db`，避免根 v1 SQLite `drizzle.config.ts` 被误用。
> **技术栈：** TypeScript strict、Zod、Fastify、PostgreSQL 16、Drizzle PG、Vitest、Playwright、pnpm/Turborepo。

## 总体 PR 队列

| 顺序 | PR             | 内容                                    | 前置              |
| ---: | -------------- | --------------------------------------- | ----------------- |
|    0 | governance     | ADR-10、当前任务书、计划与状态修正      | main@9da3c5f      |
|    1 | A3             | 租户矩阵/三元键/RLS 模板契约            | governance        |
|    2 | A5             | session/refresh/CSRF/PIN 契约           | governance        |
|    3 | A6             | identity/platform 首批命令              | A1/A2/A5          |
|    4 | A7             | OpenAPI 3.1、快照和生成类型             | A1/A2/A5/A6       |
|    5 | B2             | 校验链纯函数/ports                      | A1/A2/A6          |
|    6 | B4             | 风险与阈值升级纯函数                    | A1                |
|    7 | DB             | `packages/db` 正式 PG schema/migrations | A3/A5/A6          |
|    8 | C2             | 事务、GUC、roles、五类旁路              | DB                |
|    9 | C1+C3          | Command Bus + 同事务审计                | B2/C2             |
|   10 | C6+C8          | identity + 服务端认证上下文             | A5/A6/C1/C2       |
|   11 | C5             | Policy/确认卡/step-up                   | B4/C1/C6          |
|   12 | C4+C7          | Tool Registry + platform                | C1/C3/C5/C6       |
|   13 | Edge/Web       | Codex core + Grok adapters/E1/E3        | A4/A5/A6/A7/C6/C8 |
|   14 | F1+integration | 迁移试跑、真实 compose、全门禁          | DB/C1—C8          |

## Task 0：恢复可信基线并交付治理 PR

**文件：**

- 修改：`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`GROK.md`
- 新增：`docs/adr/2026-07-21-adr-10-single-owner-delivery-governance.md`
- 新增：`docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md`
- 新增：`docs/superpowers/plans/tasks/2026-07-21-task-codex-lead.md`
- 新增：`docs/superpowers/plans/tasks/2026-07-21-task-grok-assist.md`
- 修改：架构 spec、M0/M1 计划、M2—M6 计划、验收索引和旧任务书 superseded 标记

**步骤：**

1. 只读确认 PR #54 的两项 check 均 success、mergeable=CLEAN。
2. 合并 #54；`git fetch origin` 后确认 main 两个 workflow 在 `9da3c5f` 同一 SHA success。
3. 将治理分支 rebase 到新 main，检查仅文档/代理入口，无生产代码。
4. 运行 `pnpm exec prettier --check` 覆盖所有改动 Markdown/入口文件。
5. 运行 Markdown 链接与 stale-owner 扫描：旧文档允许出现历史名称，但所有当前入口必须指向 ADR-10。
6. 提交 `[LAUNDRY][GOVERNANCE] 切换单一技术负责人交付模型`，尾行写 Codex Co-Authored-By。
7. Push、开独立 PR，附审计矩阵、规格复审三轮结果和 #54/main 基线证据；required checks 通过后合并并复核 main。

## Task 1：A3 租户矩阵与 RLS 契约

**文件：**

- 新增：`packages/contracts/src/tenant/table-matrix.ts`
- 新增：`packages/contracts/src/tenant/keys.ts`
- 新增：`packages/contracts/src/tenant/rls-templates.ts`
- 新增：`packages/contracts/test/tenant-table-matrix.test.ts`
- 新增：`packages/contracts/test/tenant-keys.test.ts`
- 新增：`packages/contracts/test/rls-templates.test.ts`
- 修改：`packages/contracts/src/index.ts`、`packages/contracts/README.md`
- 新增：`docs/superpowers/plans/tasks/m1-acceptance/a3-tenant-rls.md`

**步骤：**

1. 从 M0-1 `schema.sql`/`policy-templates.sql` 提取候选语义，不复制 spike 文件或证据标签。
2. 先写表矩阵失败测试：org/store/global 三类、每张 M1 表归属唯一、未知表拒绝。
3. 运行 `pnpm --filter @laundry/contracts test -- tenant-table-matrix`，确认红。
4. 实现不可变表矩阵与穷举类型。
5. 先写三元键失败测试：组合唯一键/外键列顺序不一致必须拒绝。
6. 实现键描述与验证器，不在 contracts 内连接数据库。
7. 先写 RLS 模板测试：必须同时包含 `USING`/`WITH CHECK`、`ENABLE`/`FORCE`、maintenance policy；禁止字符串插值未校验标识符。
8. 实现安全 SQL 模板构造器和标识符白名单。
9. 运行 contracts test/typecheck/coverage，更新 README 与 A3 验收单。
10. 提交独立 A3 PR；状态只写“契约冻结候选”，不写“生产 RLS 已完成”。

## Task 2：A5 会话、CSRF 与 PIN 契约

**文件：**

- 新增：`packages/contracts/src/auth/session.ts`
- 新增：`packages/contracts/src/auth/refresh.ts`
- 新增：`packages/contracts/src/auth/csrf.ts`
- 新增：`packages/contracts/src/auth/pin.ts`
- 新增：`packages/contracts/test/auth-*.test.ts`
- 修改：`packages/contracts/src/index.ts`、`packages/contracts/README.md`
- 新增：`docs/superpowers/plans/tasks/m1-acceptance/a5-session-csrf.md`

**步骤：**

1. 写 access/refresh TTL、cookie 属性、rotation family、reuse 事件的失败测试。
2. 写 CSRF 双提交 header/cookie 同值、跨源拒绝、safe method 规则测试。
3. 写 PIN 快切 challenge、attempt/lockout、step-up purpose/expiry 的失败测试。
4. 确认测试红后实现 Zod schemas 与品牌类型。
5. 加 secret/PII 的 example 禁止和 result redaction 测试。
6. 导出契约并运行全 contracts 回归；文档明确 access token 仅内存、refresh 为 httpOnly+SameSite。
7. 提交独立 A5 PR。

## Task 3：A6 identity/platform 首批命令

**文件：**

- 新增：`packages/contracts/src/commands/identity.ts`
- 新增：`packages/contracts/src/commands/platform.ts`
- 新增：`packages/contracts/test/identity-commands.test.ts`
- 新增：`packages/contracts/test/platform-commands.test.ts`
- 修改：`packages/contracts/src/index.ts`
- 更新：`docs/superpowers/plans/tasks/m1-acceptance/a6-first-command-definitions.md`

**步骤：**

1. 读取未发布 A6 草稿，仅提取命令清单；不沿用过时前置判断。
2. 为每个命令先写 metadata 完整性测试：risk、offline_mode、idempotent、classification、limits、redaction。
3. 写 RBAC binding、R5 不投影、secret 不提供 example 的失败测试。
4. 实现 login/refresh/logout/PIN switch/store/staff/settings/feature/audit query 定义。
5. 运行 A1 integrity/fuzz 回归，确认 transform/literal 注册问题不复发。
6. 更新验收单，提交独立 A6 PR。

## Task 4：A7 OpenAPI 3.1 与生成类型

**文件：**

- 新增：`packages/contracts/src/openapi/build-document.ts`
- 新增：`packages/contracts/scripts/generate-openapi.ts`
- 新增：`packages/contracts/test/openapi-snapshot.test.ts`
- 新增：`packages/contracts/openapi/laundry-v2.openapi.json`
- 修改：`packages/contracts/package.json`、根 `package.json`
- 修改：`package-lock.json`、`pnpm-lock.yaml`

**步骤：**

1. 先写快照测试，断言 OpenAPI 3.1、统一 envelope、auth/csrf header、命令 schema 完整。
2. 运行测试确认缺生成器而红。
3. 安装兼容 Zod 版本的 OpenAPI 生成依赖，同时更新双锁文件。
4. 实现确定性排序和生成脚本，禁止时间戳进入快照。
5. 生成文档；第二次运行必须产生零 diff。
6. 增加消费侧编译测试，证明 Web 生成类型可导入。
7. 运行 frozen-lockfile、contracts tests 和 workspace check；提交独立 A7 PR。
8. A1—A7 全组通过且 ADR-09 已签署后，向 manpengan 提交 `contracts@v0.1.0` tag 建议。

## Task 5：B2 校验链纯函数与 ports

**文件：**

- 新增：`packages/domain/src/command-chain/types.ts`
- 新增：`packages/domain/src/command-chain/evaluate.ts`
- 新增：`packages/domain/src/command-chain/__tests__/evaluate.test.ts`
- 修改：`packages/domain/src/index.ts`、`packages/domain/vitest.config.ts`

**步骤：**

1. 写固定顺序测试：Zod→RBAC→tenant→Policy→invariant；首个失败即停止。
2. 写不可变 context/result 和异常显式传播测试。
3. 确认红后实现纯函数 orchestrator；IO 只以 port 回调注入。
4. 加 coverage threshold=100%，运行 domain 全量测试。
5. 提交独立 B2 PR。

## Task 6：B4 风险与阈值升级

**文件：**

- 新增：`packages/domain/src/risk/evaluate-risk.ts`
- 新增：`packages/domain/src/risk/measure-input.ts`
- 新增：`packages/domain/src/risk/__tests__/evaluate-risk.test.ts`
- 修改：`packages/domain/src/index.ts`

**步骤：**

1. 写 R0—R5 基础判定、R3→R4 唯一升级、hard limit 先于 escalation 的测试。
2. 写 RFC 6901 路径、array length、numeric sum、非法/溢出/负数 fail-closed 测试。
3. 写 per-org override 只可调严的性质测试。
4. 确认红后实现纯函数；金额只用 safe integer cents。
5. 运行 100% coverage，提交独立 B4 PR。

## Task 7：正式 v2 PG 包与 migrations

**文件：**

- 新增：`packages/db/package.json`、`packages/db/tsconfig.json`
- 新增：`packages/db/src/schema/**`
- 新增：`packages/db/src/migrations/**`
- 新增：`packages/db/drizzle.config.ts`
- 新增：`packages/db/test/schema-contract.test.ts`
- 修改：双锁文件、Turborepo/CI paths（如需要）

**步骤：**

1. 写架构测试：v2 DB 配置不得引用根 v1 SQLite config/better-sqlite3。
2. 写 schema contract 测试，覆盖 tenant matrix、复合键、audit append-only、pending action、identity/lease 表。
3. 确认红后建立 PG Drizzle schema 与 expand/migrate/contract 目录。
4. 把 A3 SQL 模板落成 migration，创建 owner/laundry_app/worker 角色与 maintenance policy。
5. 在临时 PG 上执行 migrate twice，断言幂等且 schema diff 为空。
6. 增加 destructive migration 静态拒绝测试，提交独立 DB PR。

## Task 8：C2 RLS 事务封装

**文件：**

- 新增：`apps/server/src/db/pool.ts`
- 新增：`apps/server/src/db/tenant-transaction.ts`
- 新增：`apps/server/src/db/worker-transaction.ts`
- 新增：`apps/server/src/db/__tests__/rls-isolation.test.ts`

**步骤：**

1. 将 M0-1 五类旁路改成正式 integration tests，先证明未接封装时失败。
2. 实现参数化 `SET LOCAL app.org_id/store_id/staff_id`，只接受服务端验证 UUID。
3. 应用连接使用 `laundry_app`，migration/seed 使用 owner；worker 强制同一三元注入。
4. 增加非法 UUID、rollback、pool reuse、worker missing、maintenance role 负向测试。
5. 运行 10 万单查询预算回归；提交 C2 PR。

## Task 9：C1 Command Bus + C3 审计

**文件：**

- 新增：`apps/server/src/bus/**`
- 新增：`apps/server/src/audit/**`
- 新增：`apps/server/src/architecture/**`
- 新增：`apps/server/src/__tests__/command-bus.test.ts`
- 新增：`apps/server/src/__tests__/audit-rollback.test.ts`

**步骤：**

1. 写架构 lint 测试：routes/AI/worker 只能调用 bus，不得 import 写 service/repository。
2. 写固定校验顺序、幂等、dry-run、领域事件 after-commit 测试。
3. 写“业务成功+审计失败=整体回滚”集成测试。
4. 实现 registry loader、chain adapter、transaction executor 与 audit decorator。
5. DB grant 测试断言 app 对 audit 仅 INSERT，无 UPDATE/DELETE/TRUNCATE。
6. 提交 C1+C3 纵向 PR。

## Task 10：C6 identity + C8 auth middleware

**文件：**

- 新增：`apps/server/src/identity/**`
- 新增：`apps/server/src/auth/**`
- 新增：`apps/server/src/http/plugins/auth.ts`
- 新增：`apps/server/src/__tests__/identity-negative.test.ts`
- 新增：`apps/server/src/__tests__/tenant-spoofing.test.ts`

**步骤：**

1. 基准 Windows 目标 CPU 上的 Argon2id 参数，记录 memory/time/parallelism 依据。
2. 写 login、refresh rotation/reuse、logout/session revoke、PIN switch、RBAC 测试。
3. 写 PIN rate-limit/lockout、session fixation、CSRF cross-origin、step-up expiry/不可自核负向测试。
4. 写客户端/LLM/Edge 自报 org/store 全部被忽略或拒绝的测试。
5. 实现 cookie/session/auth plugin；actor/tenant 只从服务端会话构造。
6. 通过 bus 执行所有写命令并落审计；提交 C6+C8 PR。

## Task 11：C5 Policy、确认卡与 step-up

**文件：**

- 新增：`apps/server/src/policy/**`
- 新增：`apps/server/src/pending-actions/**`
- 新增：`apps/server/src/__tests__/wysiwys.test.ts`
- 新增：`apps/server/src/__tests__/step-up.test.ts`

**步骤：**

1. 写 R0—R5/via/RBAC/threshold 决策表测试。
2. 写 canonical args 冻结、hash、entity version、nonce、5min expiry、idempotency 测试。
3. 写确认只提交 nonce、参数换新卡、原子单次消费、不可自核、并发确认恰一成功测试。
4. 实现 pending action repository 与 Policy middleware；全部在事务内执行。
5. 跑 WYSIWYS 和 AI 注入负向集；提交 C5 PR。

## Task 12：C4 Tool Registry 与 C7 platform

**文件：**

- 新增：`apps/server/src/tools/**`
- 新增：`apps/server/src/platform/**`
- 新增：`apps/server/src/__tests__/tool-registry.test.ts`
- 新增：`apps/server/src/__tests__/platform-via-bus.test.ts`

**步骤：**

1. 写 R5/secret 不投影、per-preset 白名单、redaction/limits 映射测试。
2. 实现只读 registry 投影，不发真实模型请求。
3. 从旧 C7 分支只提取命令清单/测试意图；不复制内存 Map/array repository。
4. 写设置/feature/audit query 必须经过 bus/RLS/audit 的架构测试。
5. 实现 PG repository 与 A6 handlers；提交 C4+C7 PR。

## Task 13：Edge/Web 协助线

**Codex 文件：** `apps/edge-agent/src/core/**`、`security/**`、`queue/**`、`lease/**`、contracts ports。
**Grok 文件：** `apps/edge-agent/src/platform/**`、`drivers/**`、`packaging/**`、`apps/web/**`、`packages/ui/**`。

**步骤：**

1. Codex 先为配对、secret store、queue storage、printer、updater 定义 ports 和负向 contract tests。
2. Codex 实现 canonical/signature/DEK-KEK/lease/replay/manifest 核心，确认无平台 I/O。
3. Grok 分独立 PR 实现 OS/SQLCipher/autoUpdater/打印 adapters；不得修改 core tests 来放宽语义。
4. A5/A6/A7 后，Grok 实现 E1/E3；C6/C8 后跑登录/PIN/越权黑盒。
5. Windows 与三打印机实测未完成时，只标记代码侧通过。

## Task 14：F1 与 M1 集成门禁

**文件：**

- 新增：`tools/migrate-v1/**`
- 修改：`tools/compose/**`、`tools/seed/**`
- 新增：`.github/workflows/v2-integration.yml`
- 新增：`tests/architecture/**`、`tests/security/**`、`tests/e2e/**`

**步骤：**

1. 为 v1 SQLite fixture 写只读 extract 测试；禁止任何 source UPDATE/DDL。
2. 写 qty 拆 order_lines+garments、补条码、expected pickup 补算测试。
3. 写金额/件数/客户数 reconciliation，任一非零即进程失败。
4. compose 替换 mock cloud server 为真实 apps/server；seed 对正式 schema 执行两次可重复。
5. CI 加 PG migration、五类 RLS、审计回滚、身份负向、WYSIWYS、红队、OpenAPI、Playwright。
6. 运行 `pnpm run workspace:check`、v2 integration、v1 Build/Release；记录两条流水线不可互相替代。
7. 生成 M1 门禁报告；main 与外部实测全部满足后才建议进入 M2。

## 提交原则

- 每个表格 PR 单独提交，不把后续任务夹带进前置 PR。
- 每个 commit 尾行：`Co-Authored-By: Codex <codex@openai.com>`；Grok 使用自己的署名。
- “测试绿”必须附命令和真实输出；失败测试必须先被观察到。
- 需要真实 key、Windows、打印机或宏发只读数据时，外部条件未到位就停止在“代码侧通过/待实测”，不降级措辞。
