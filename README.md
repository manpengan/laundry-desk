# laundry-desk

产品目标是面向洗衣店行业提供通用 V2 柜台与经营系统，规划支持多租户、离线柜台、硬件打印和 AI-first 操作。

当前优先在 hk-vps 的 ADR-36 云测试环境收敛 Linux Web Server/Web 产品功能；已交付的 macOS Counter/Runtime 保持有效，但桌面 App 与 Windows 适配移出当前关键路径。该公网环境只允许合成测试数据，不等于生产 SaaS 上云。

## 当前状态

| 项         | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动路线   | **通用 V2 本地优先交付**（[ADR-14](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)）；[ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md) 保留为 V2-only 基础裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 当前阶段   | ADR-36 hk-vps 云测试环境：公网 HTTPS 下收敛 Linux Server/Web，桌面 App 后置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 设计真源   | [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md) · [Claude V2 架构](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md) · [ADR-16](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) · [ADR-22](docs/adr/2026-08-01-adr-22-member-stored-value-phase-2.md) · [ADR-26](docs/adr/2026-08-07-adr-26-lan-owner-dashboard.md) · [ADR-27](docs/adr/2026-08-08-adr-27-owner-drilldown-portfolio.md) · [ADR-28](docs/adr/2026-08-08-adr-28-lan-onboarding-diagnostics.md) · [ADR-29](docs/adr/2026-08-08-adr-29-runtime-managed-backup-restore.md) · [ADR-30](docs/adr/2026-08-08-adr-30-runtime-release-upgrade-rollback.md) · [ADR-31](docs/adr/2026-08-08-adr-31-store-commissioning-staff-credentials.md) |
| 当前 owner | **Codex** — 设计、实现、集成与门禁                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 目标平台   | 当前：hk-vps Linux Server/Web 云测试；后续：桌面 App、Windows 与正式生产云部署                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

当前已完成：`Local Foundation → 完整柜台工作日 → 履约/顾客/员工治理 → 本地备份恢复 → 加密离线队列与 Primary → 重放对账 → 会员储值二期 → 催取人工名单 → 双口径账目 → 会员账户生命周期 → LAN Owner → Runtime 数据保护/升级 → 正式候选软件证据 → ADR-36 hk-vps 云测试入口`。`https://desk.manpengan.xyz` 提供完整但必须认证的测试柜台面；禁止真实顾客 PII。正式 Developer ID/公证、已发布双架构 OCI、XP-58 实体打印、生产级云部署和 Windows 仍是独立后续门禁。

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

`ADR-36 云测试环境收敛 → 产品功能完成 → 桌面 App/Windows 适配 → 正式发布外部门禁`

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

首次启动前按[本地联调指南](docs/local-web-server.md)提供两位管理员的八个临时输入。涉及旧根配置或 v1
迁移兼容时，再运行根 `lint/test/typecheck/build`。没有 Windows、PostgreSQL、真实模型 key
或打印机证据时，只能标记“代码侧通过/待实测”。

hk-vps 云测试部署、回滚、登录 smoke 和维护重启见
[ADR-36 运维手册](docs/operations/2026-08-09-hk-vps-cloud-test.md)。

## License

私有项目（manpengan 个人所有）。
