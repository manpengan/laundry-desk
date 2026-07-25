# laundry-desk

产品目标是面向洗衣店行业提供通用 V2 柜台与经营系统，规划支持多租户、离线柜台、硬件打印和 AI-first 操作。

当前优先完成本地 Web Server 与 macOS App，覆盖登录/PIN、收件、取衣、客户、付款/欠款、照片、统计、交班、打印、通知、权限与审计。

## 当前状态

| 项         | 值                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动路线   | **通用 V2 本地优先交付**（[ADR-14](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)）；[ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md) 保留为 V2-only 基础裁决 |
| 当前阶段   | Local Foundation：先收口可重复启动、安全会话、本地 Web 与 macOS 壳                                                                                                                            |
| 设计真源   | [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md) · [Claude V2 架构](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)                       |
| 当前 owner | **Codex** — 设计、实现、集成与门禁                                                                                                                                                            |
| 目标平台   | 本地 Web Server + macOS App 优先；云服务器部署与 Windows 适配后置                                                                                                                             |

当前只按此顺序交付：`Local Foundation → Money Integrity → Workday Commands → Counter UI → Mock Print → Acceptance → later cloud/Windows`。

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

`Local Foundation → Money Integrity → Workday Commands → Counter UI → Mock Print → Acceptance → later cloud/Windows`

历史 [Grok owner 任务书](docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md) 仅作治理记录，不是当前执行入口。

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
