# laundry-desk

产品目标是面向洗衣店行业提供通用 V2 柜台与经营系统，规划支持多租户、离线柜台、硬件打印和 AI-first 操作。

ADR-36 的 hk-vps Linux Web Server/Web 收口证据继续有效；当前按[后续 1–6 交付计划](docs/superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)依次推进，先收口 macOS 桌面 App 的当前 Web 产品面与 Runtime 托管回环，再进入 XP-58 真机、正式 macOS 发布、Windows、生产 SaaS 和 AI/迁移阶段。任何后续阶段都不能用软件模拟或云测试证据替代自己的外部门禁。

## 当前状态

| 项         | 值                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动路线   | **通用 V2 后续 1–6 顺序交付**：[ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md) 保留 V2-only 基础裁决，[ADR-14](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md) 定义本地优先基线，[ADR-16](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) 约束能力边界，[ADR-36](docs/adr/2026-08-09-adr-36-cloud-test-environment.md) 保留 hk-vps 云测试环境裁决                   |
| 当前阶段   | **阶段 2 外部硬件阻塞**：阶段 1 已合入 `main=7e72b57` 且主线门禁全绿；当前 Mac 未发现 CUPS 队列、USB Printer 接口、USB 串口打印桥或局域网 IPP 打印服务。打印软件链与实体证据入口继续收口，但必须接入并通电 XP-58 后才能形成出纸、扫码和断连补打证据                                                                                                                                                                   |
| 设计真源   | [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md) · [ADR-16](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) · [ADR-36](docs/adr/2026-08-09-adr-36-cloud-test-environment.md) · [后续 1–6 交付计划](docs/superpowers/plans/2026-08-10-post-adr36-delivery-plan.md) · [XP-58 实体打印验收](docs/superpowers/specs/2026-08-10-xp58-physical-print-acceptance.md) |
| 当前 owner | **Codex** — 设计、实现、集成与门禁                                                                                                                                                                                                                                                                                                                                                                                    |
| 目标平台   | 当前：XP-58 真机与本机 CUPS；随后依次为 macOS 正式发布、Windows 真实主机、生产 SaaS、多门店/运维及 AI/迁移                                                                                                                                                                                                                                                                                                            |

已交付的代码面包括 `Local Foundation → 完整柜台工作日 → 履约/顾客/员工治理 → 本地备份恢复 → 加密离线队列与 Primary → 重放对账 → 会员储值二期 → 催取人工名单 → 双口径账目 → 会员账户生命周期 → LAN Owner → Runtime 数据保护/升级 → 正式候选软件证据`。ADR-36 的 `ae9808c` 云测试记录证明了公网/loopback 最小路径和一批安全可执行的 HTTP 业务纵向，但历史催取正向 fixture 与远端浏览器 UI 仍 pending；该环境禁止真实顾客 PII，也不等于生产 SaaS。当前 macOS 新鲜证据只属于 **software-only**：Browser、打包 Counter 产品面对齐和 Runtime 真实托管回环都已通过。它们不冒充 XP-58 实体打印、Developer ID/公证、正式双架构 OCI、Windows 实机或生产云证据。

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

`1 macOS 当前 Web 产品面 + Runtime 托管回环 → 2 XP-58 真机 → 3 Developer ID/公证/正式双架构 OCI → 4 Windows 真实主机 → 5 生产 SaaS/多门店/运维 → 6 AI/BYOK/v1 迁移/外部提供商`

当前执行入口是[后续 1–6 交付计划](docs/superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)。每一阶段都必须测试通过、经 PR 合入 `main` 且 required CI 绿灯，才开始下一阶段；外部硬件、证书或主机缺失时应明确阻塞，不能跳过。历史 [ADR-36 Web 产品收口计划](docs/superpowers/plans/2026-08-09-adr36-web-product-convergence-plan.md)、[V2-M2 → V2-M6 计划](docs/superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md) 与 [Grok owner 任务书](docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md) 仅作决策沿革和既有证据记录。

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
pnpm run local:acceptance
pnpm run local:commissioning:fresh:mac
pnpm run runtime:counter:acceptance
pnpm run local:down
```

首次启动前按[本地联调指南](docs/local-web-server.md)提供两位管理员的八个临时输入。涉及旧根配置或 v1
迁移兼容时，再运行根 `lint/test/typecheck/build`。`runtime:counter:acceptance` 只证明本机软件托管组合；没有 Windows、PostgreSQL、真实模型 key、正式签名材料或打印机证据时，只能标记“代码侧通过/待实测”。

hk-vps 云测试部署、回滚、登录 smoke 和维护重启见
[ADR-36 运维手册](docs/operations/2026-08-09-hk-vps-cloud-test.md)。

## License

私有项目（manpengan 个人所有）。
