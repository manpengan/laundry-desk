# laundry-desk

产品目标是面向洗衣店行业提供桌面为主、Web 次之的柜台与经营系统，规划支持多租户、离线柜台、硬件打印和 AI-first 操作。

计划覆盖登录/PIN、收件、取衣、客户、付款/欠款、照片、统计、交班、打印、通知、权限、审计与 v1 数据升级。

## 当前状态

| 项         | 值                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动路线   | **仅 v2 产品化升级**（[ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)）                                                          |
| 当前阶段   | V2-M1 基座已形成，`contracts@v0.1.0` 已封版；正在完成 V2-M2 宏发升级候选版                                                                        |
| 设计真源   | [v2 架构](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md) · [Web UI](docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md) |
| 当前 owner | [Grok 单一技术负责人](GROK.md)（ADR-12） · [活动任务书](docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md)                                |
| 目标平台   | Windows 10/11 桌面 Edge + React SPA；云端或自托管 PostgreSQL                                                                                      |

当前 main 已合入 V2-M1 基座和部分 V2-M2 代码增量；真实 PostgreSQL CI、v1 数据迁移、Edge 离线闭环、AI/BYOK 生产路径及 Windows/打印机实机验收尚未收口。

宏发 v1 单店版已经冻结，不再增加 M4/M5 功能或独立发版。根 `src/` 只作为 `tools/migrate-v1` 的只读迁移源、历史行为参考与限期只读回退；历史设计见 [v1 archived spec](docs/superpowers/specs/2026-04-23-laundry-desk-design.md)。

## 架构

```text
Web / Desktop SPA / AI / Automation / Edge replay
                       │
              Command / Query Bus
                       │
Fastify + Policy + Audit + PostgreSQL 16 / FORCE RLS
                       │
 Local Edge Agent: offline queue · signed templates · printers
```

人工按钮、AI 工具、自动化策略与离线回放共用同一命令入口。浏览器不直连数据库、不持有设备私钥，也不保存交易/审计离线真源。

## 技术栈

Node.js 22 · pnpm 11 · Turborepo · TypeScript strict · Zod 4 · Fastify 5 · PostgreSQL 16 · Drizzle · React 19 · Vite · Electron 41 · Vitest · Playwright

## 路线图

| 期        | 交付范围                                                           |
| --------- | ------------------------------------------------------------------ |
| V2-M0     | RLS、lease、打印、本地通道、模型 adapter 与 compose 技术验证       |
| V2-M1     | contracts、Command Bus、RLS、Identity、Policy、Edge/Web 基座       |
| **V2-M2** | **柜台完整工作日 + 只读 AI/BYOK + 离线闭环 + v1 数据迁移（当前）** |
| V2-M3     | 会员储值、通知/催取、开放 R3 确认写                                |
| V2-M4     | 账务双口径、老板端、备份还原                                       |
| V2-M5     | AI 全矩阵、审批、限额与有边界自动化                                |
| V2-M6     | 视觉、小程序、工厂协同、取送与营销（四个独立子期）                 |

详细计划：

- [V2-M2→M6 实施计划](docs/superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md)
- [V2-only 升级执行计划](.hermes/plans/2026-07-23_034229-v2-only-upgrade-next-development-plan.md)
- [ADR 索引](docs/adr/README.md)

## 仓库结构

- `apps/server`：Fastify、认证、Bus、Policy、PG handlers
- `apps/web`：柜台 SPA
- `apps/edge-agent`：Electron、离线、打印、升级
- `packages/contracts`：Zod/OpenAPI/命令查询真源
- `packages/domain`：零 IO 领域函数
- `packages/db`：v2 PostgreSQL schema/migrations/RLS
- `packages/ui`：共享设计系统
- `tools`：compose、seed、迁移与实机实验室
- `src`：冻结的 v1 迁移源与历史实现

## 开发与门禁

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run workspace:check
pnpm run local:server:pg
pnpm run local:web
pnpm run local:web:e2e
```

涉及旧根配置或 v1 迁移兼容时，再运行根 `lint/test/typecheck/build`。没有 Windows、PostgreSQL、真实模型 key 或打印机证据时，只能标记“代码侧通过/待实测”。

## License

私有项目（manpengan 个人所有）。
