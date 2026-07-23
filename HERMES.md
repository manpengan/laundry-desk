# HERMES.md — laundry-desk

Hermes Agent 在本仓库中的入场与执行指引。

> **治理边界（ADR-12 / ADR-13）**：Grok 是当前单一技术负责人，负责设计真源、实现、门禁与交付；v2 是唯一活动交付线。Hermes 作为结对工程与验证代理参与，不拥有 spec、contracts、冻结、放行或合并决策权；本文件不覆盖 `AGENTS.md`、`GROK.md`、Accepted ADR 或 manpengan 的裁决。

## 1. 项目是什么

laundry-desk 是洗衣店柜台管理系统，覆盖开单、取衣、顾客、收款/欠款、统计、交班、照片、打印、通知、权限与审计。

仓库只保留一条活动开发线：

- **v2 产品化升级线**：`apps/` + `packages/`，桌面为主、Web 次之；Node/Fastify + PostgreSQL/RLS + Local Edge Agent + AI-first Command Bus，支持多租户与后续 SaaS/自托管。
- **v1 冻结资产**：根目录 `src/` 不再开发功能，只用于 `tools/migrate-v1` 的只读迁移、历史行为对照与限期只读回退。详见 [ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)。

v2 的核心原则是：人工 UI、AI、自动化和 Edge 离线回放共用同一 Command/Query Bus；浏览器不直连数据库、不持有设备私钥，也不承担交易离线真源。

## 2. 真源优先级

发生冲突时按以下顺序处理：

1. manpengan 的当前书面/会话裁决；
2. Accepted ADR 与交付治理；
3. 当前 v2 架构 spec；
4. `GROK.md`、当前任务书与里程碑计划；
5. contracts 代码、测试、tag 与 `origin/main`；
6. README、CHANGELOG、历史任务书和未合并分支。

`origin/main` 是唯一代码真源。未合并分支只能作为候选输入，不得据此宣称功能已交付。README、CHANGELOG 和旧计划中的状态可能滞后，汇报进度前必须重新检查 git、CI 与实际代码。

## 3. 入场必读

1. [`AGENTS.md`](AGENTS.md)
2. [`GROK.md`](GROK.md)
3. [ADR-13：V2-only 升级交付](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)
4. [ADR-12](docs/adr/2026-07-21-adr-12-grok-unified-delivery-ownership.md)
5. [交付治理](docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md)
6. [v2 架构](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)
7. [M2–M6 实施计划](docs/superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md)
8. [V2-only 执行计划](.hermes/plans/2026-07-23_034229-v2-only-upgrade-next-development-plan.md)
9. 若当前环境存在：`~/pro/kb/projects/laundry-desk/status.md`

只读与本次任务有关的 ADR、验收单、代码和测试；不要用历史 owner 文案覆盖 ADR-12。

## 4. 代码地图

- `apps/server/`：Fastify/API、认证、Command/Query Bus、Policy、PG 适配与业务 handlers。
- `apps/web/`：柜台 SPA、登录/PIN、开单/取衣、顾客、统计、设置与工作台。
- `apps/edge-agent/`：Electron 壳、本地安全边界、配对、打印、离线队列与升级能力。
- `packages/contracts/`：Zod 契约、统一信封、命令/查询定义与 OpenAPI；跨端类型真源。
- `packages/domain/`：零 IO 领域纯函数与状态机。
- `packages/db/`：v2 PostgreSQL schema、migrations、RLS 与 grants。
- `packages/ui/`：液态玻璃 token 与共享组件。
- `src/`：冻结的 v1 Electron/SQLite 实现，只读迁移与行为参考；不得新增业务功能。
- `tools/`：compose、迁移、seed、打印机/Windows 实机实验室。
- `docs/`：spec、ADR、计划、验收与研究记录。

## 5. 工作方式

1. 开始前重新检查分支、`origin/main`、工作区和相关 CI；不要依赖会话启动快照。
2. 先定位定义、调用方、契约、数据库约束和现有测试，再修改代码；依赖必须从 manifest 与邻近实现确认。
3. 所有新工作默认属于 v2；若必须触碰 `src/`，先证明它只为迁移、数据可读性或安全取证解阻。
4. 采用小步 TDD：先观察失败测试，再做最小实现，最后回归相关包与全量门禁。
5. 写路径优先经过现有 Command Bus；不得从 route、AI 或 worker 绕过总线直调写 repository/service。
6. Accepted ADR 不回改决策正文；需要改变设计时新增 ADR。
7. 增删依赖时同步 `pnpm-lock.yaml` 与 `package-lock.json`，并验证两条 CI 路径。
8. 不提交真实客户 PII、真实手机号、密钥或硬件证据中的 EXIF；种子手机号使用 `13800000xxx`。
9. 未经用户明确要求，不 commit、push、合并、改写历史或直接发布。

## 6. 不可突破的工程红线

- TypeScript `strict`，禁止 `any`；文件、函数与嵌套遵守项目规模红线。
- 所有 IPC/HTTP/工具边界过 Zod，并返回统一 `{ ok, data } | { ok, error }` 信封。
- 金额全程使用整数分，渲染统一走金额组件/函数，禁止浮点金额。
- 多表写入必须在事务内；业务变更与审计同事务，审计失败则整体回滚。
- 租户/actor 只从服务端认证会话注入；忽略或拒绝浏览器、LLM、Edge 自报的 org/store。
- PostgreSQL 租户表启用并强制 RLS；应用角色不得拥有 BYPASSRLS，worker 同样注入 GUC。
- Edge 只负责受约束的执行、暂存和设备 I/O，不复制业务校验语义。
- 浏览器不保存设备私钥，不以 IndexedDB 保存交易/审计真源。
- Electron 保持九项安全基线：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、最小 preload、IPC sender 校验、禁任意新窗口/导航、权限默认拒绝。
- 证据强度必须不低于结论：mock、文件 spool、代码侧通过、CI 绿、Windows 实机和真机打印是不同等级。

## 7. 验证基线

先跑最小相关门禁，再按改动范围扩大：

```bash
pnpm --filter @laundry/<package> test
pnpm --filter @laundry/<package> typecheck
pnpm --filter @laundry/<package> lint
pnpm run workspace:check
```

涉及 v1 迁移兼容或共享根配置时再跑历史兼容门禁：

```bash
pnpm run test
pnpm run lint
pnpm run typecheck
pnpm run build
```

涉及 UI、server/PG 或桌面链路时，补相应 Playwright、本地 PG/compose、Windows 或打印机验证。没有对应环境或设备时，只能报告“代码侧通过/待实测”，不能写“实机通过”。

## 8. 汇报格式

每次完成任务至少说明：

- 当前分支与基线 SHA；
- 修改范围和关键行为；
- 实际执行的测试/构建及结果；
- 尚未覆盖的环境、硬件、迁移或安全门禁；
- 下一步按依赖顺序排列，不把候选分支或骨架写成已交付。

本文件是稳定的执行入口，不是动态进度账；当前进度始终以 live git、CI、代码和验收证据重新判定。
