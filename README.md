# laundry-desk

产品目标是面向洗衣店行业提供通用 V2 柜台与经营系统，规划支持云端 Web、离线柜台、硬件打印和 AI-first 操作。

[ADR-37](docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) 已把 hk-vps Linux Web Server/Web
确定为当前主交付与开发测试形态。后续按 [Cloud Web-first 1–4 交付计划](docs/superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)
依次收口云端基线、柜台可信性缺口、经营增强与大型云端模块。Windows、macOS 桌面 App
正式发行、XP-58 实体验收和逐功能桌面适配先不做；历史成果保留，但不再阻塞 Web 功能开发。

## 当前状态

| 项         | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动路线   | **Cloud Web-first 1–4 顺序交付**：[ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md) 保留 V2-only 基础裁决，[ADR-14](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md) 保留通用 V2 架构基线，[ADR-16](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) 约束能力边界，[ADR-36](docs/adr/2026-08-09-adr-36-cloud-test-environment.md) 定义公网安全边界，[ADR-37](docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) 定义当前主形态与顺序 |
| 当前阶段   | **阶段 2 已关闭；阶段 3「经营增强」待开始**。阶段 2 按 1→2→3 完成实现、真实 PostgreSQL/Browser、PR #167、精确 merge SHA 主干 CI 与 hk-vps `prepare → finalize`；已部署 marker 为 `6f106076018940eec8fcc9e8c2cfb7842c323f47`，migration head 为 `0047_cloud_counter_trust.sql`。见[阶段 2 验收记录](docs/superpowers/specs/2026-08-11-stage2-counter-trust-acceptance.md)与[发布结果](docs/operations/2026-08-11-stage2-release-result.md)。                                               |
| 设计真源   | [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md) · [ADR-16](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) · [ADR-36](docs/adr/2026-08-09-adr-36-cloud-test-environment.md) · [ADR-37](docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md) · [ADR-38](docs/adr/2026-08-11-adr-38-cloud-counter-trust-closure.md) · [Cloud Web-first 1–4 交付计划](docs/superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)           |
| 当前 owner | **Codex** — 设计、实现、集成与门禁                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 目标平台   | 当前：`desk.manpengan.xyz` 上的 Linux Fastify/PostgreSQL + 浏览器 Web；后续桌面、操作系统安装包和实体硬件另行恢复                                                                                                                                                                                                                                                                                                                                                                         |

已交付的代码面包括 `Local Foundation → 完整柜台工作日 → 履约/顾客/员工治理 → 本地备份恢复 → 加密离线队列与 Primary → 重放对账 → 会员储值二期 → 催取人工名单 → 双口径账目 → 会员账户生命周期 → LAN Owner → Runtime 数据保护/升级 → 正式候选软件证据 → 服务端权威计价/支付退款/件级挂单恢复`。阶段 2 的 hk-vps 新鲜证据包含 API 15/15、Cloud Chromium PASS、marker/0047 与发布清理；该环境仍禁止真实顾客 PII，也不等于生产 SaaS。当前 macOS 新鲜证据只属于 **software-only**，不冒充 XP-58 实体打印、Developer ID/公证、正式双架构 OCI、Windows 实机或生产云证据。

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

`1 云端基线与既有 Web 收口 → 2 柜台可信性缺口 → 3 经营增强 → 4 大型云端模块`

当前执行入口是 [Cloud Web-first 1–4 交付计划](docs/superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)。
阶段 1、2 已依次关闭，下一实现入口是阶段 3 的四个独立经营增强切片。
每一阶段都必须测试通过、经 PR 合入 `main` 且 required CI 绿灯，再把该 `main` 精确部署并
完成公网 Web 验收，才能开始下一阶段。Windows、macOS 正式发行和 XP-58 不在这条关键路径；
真实短信/微信/支付/AI 等提供商集成必须有获授权的 sandbox 或正式回执，软件 fake 只能证明
`software_only`。历史 [ADR-36 Web 产品收口计划](docs/superpowers/plans/2026-08-09-adr36-web-product-convergence-plan.md)、
[V2-M2 → V2-M6 计划](docs/superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md) 与
[Grok owner 任务书](docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md) 仅作决策沿革和既有证据记录。

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
[ADR-36 运维手册](docs/operations/2026-08-09-hk-vps-cloud-test.md)；已完成发布见
[阶段 1 结果](docs/operations/2026-08-11-stage1-release-result.md)与
[阶段 2 结果](docs/operations/2026-08-11-stage2-release-result.md)。

## License

私有项目（manpengan 个人所有）。
