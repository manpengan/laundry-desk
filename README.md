# laundry-desk

产品目标是面向洗衣店行业提供通用 V2 柜台与经营系统，规划支持多租户、离线柜台、硬件打印和 AI-first 操作。

当前只推进 Linux 本地 Web Server + Web，覆盖登录/PIN、收件、取衣、客户、会员储值与账户生命周期、付款/欠款、照片、统计、交班、离线恢复、打印、权限与审计；macOS App 暂停开发与验收。

## 当前状态

| 项         | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动路线   | **通用 V2 本地优先交付**（[ADR-14](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)）；[ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md) 保留为 V2-only 基础裁决                                                                                                                                                                                                                                                                                                                                               |
| 当前阶段   | Linux 本地 Web 已交付 P2 会员账户冻结、解冻与原子关户；下一批进入 P3 局域网 Owner Dashboard                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 设计真源   | [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md) · [Claude V2 架构](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md) · [ADR-16](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) · [ADR-22](docs/adr/2026-08-01-adr-22-member-stored-value-phase-2.md) · [ADR-23](docs/adr/2026-08-07-adr-23-pickup-reminder-manual-list.md) · [ADR-24](docs/adr/2026-08-07-adr-24-accounting-dual-basis-reports.md) · [ADR-25](docs/adr/2026-08-07-adr-25-member-account-lifecycle.md) |
| 当前 owner | **Codex** — 设计、实现、集成与门禁                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 目标平台   | 当前：Linux 本地 Web Server + Web；macOS App、云服务器部署与 Windows 适配后置                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

当前已完成：`Local Foundation → 完整柜台工作日 → 履约/顾客/员工治理 → 本地备份恢复 → 加密离线队列与 Primary → 重放对账 → 会员储值二期 Web 柜台入口（含赠送与退款） → 催取工作台与人工名单 → 账目双口径（日/月/职员） → P2 会员账户生命周期 → 普通 offline grant → 签名打印软件链 → 独立 Runtime.app 软件`。会员账户现可挂失冻结、受权解冻，并以单笔 R4 事务退完本金、清零赠款后永久关户。催取名单只供电话或现有聊天工具人工联系，不含短信、微信或自动发送。当前 Linux Web 报表不含老板 H5 或 AI 分析；macOS 后续开发与验收暂停，云部署和 Windows 仍后置。

宏发版本停止开发；根 `src/` 只作为历史行为参考，不作为当前产品入口。

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

## 当前交付顺序

`P3 局域网 Owner Dashboard → later 工厂协同/取送/营销 → macOS/云/Windows 后置`

历史 [Grok owner 任务书](docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md) 仅作治理记录，不是当前执行入口。

## 仓库结构

- `apps/server`：Fastify、认证、Bus、Policy、PG handlers
- `apps/web`：柜台 SPA
- `apps/edge-agent`：Electron、离线、打印与发布入口
- `packages/contracts`：Zod/OpenAPI/命令查询真源
- `packages/domain`：零 IO 领域函数
- `packages/db`：v2 PostgreSQL schema/migrations/RLS
- `packages/ui`：共享设计系统
- `tools`：compose、seed、迁移、独立 Runtime.app 与实机实验室
- `src`：冻结的 v1 迁移源与历史实现

## 开发与门禁

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run workspace:check
pnpm --filter @laundry/edge-agent spa:verify
pnpm run local:up -- --bootstrap
pnpm run local:web
pnpm run local:web:e2e
pnpm run local:down
```

首次启动前按[本地联调指南](docs/local-web-server.md)提供四个临时管理员输入。涉及旧根配置或 v1
迁移兼容时，再运行根 `lint/test/typecheck/build`。没有 Windows、PostgreSQL、真实模型 key
或打印机证据时，只能标记“代码侧通过/待实测”。

## License

私有项目（manpengan 个人所有）。
