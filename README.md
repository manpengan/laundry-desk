# laundry-desk

产品目标面向洗衣店行业，当前交付通用 V2 的 Windows 本地柜台与经营系统，支持本机 Runtime、离线操作和打印。

[ADR-66](docs/adr/2026-08-29-adr-66-windows-hongfa-pilot.md) 已把后续主线切换为活动 V2 的
Windows 定制 EXE，并以宏发作为首个受控运营试点。[ADR-71](docs/adr/2026-10-02-adr-71-cloud-platform-pause.md)
明确 Windows V2 本地安装版是唯一活动交付线：自 2026-10-01 起暂停 Cloud 平台开发与部署，
已合入的代码与 CI 保留，`hk-vps-cloud-test` 现状冻结且继续只允许合成数据。
根 `src/` 与根 `build:win` 仍是冻结 v1；宏发定制只进入发行 profile，不进入通用业务核心。
真实顾客数据准入须另立本机形态生产准入 ADR；当前 Windows 开发测试只使用合成数据。

## 当前状态

2026-10-03 起按用户指令实施 A1–A9、B1–B8，范围与分批状态见
[Windows 全功能实施记录](docs/operations/2026-10-03-windows-full-feature-batches.md)和
[ADR-72](docs/adr/2026-10-03-adr-72-windows-full-feature-delivery.md)。
阿里云短信为短信适配目标；打印机与打印机端口钱箱暂缓，Cloud 继续暂停。
新增功能正在开发，以下基线实测不代表新增功能已经通过 Windows 验收。

| 项         | 值                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活动路线   | **Windows V2 本地安装版 → 宏发受控试点**：[ADR-66](docs/adr/2026-08-29-adr-66-windows-hongfa-pilot.md)、[ADR-71](docs/adr/2026-10-02-adr-71-cloud-platform-pause.md)；V2-only 继续继承 [ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)，契约边界继续继承 ADR-14/16。Cloud 平台暂停开发部署，既有代码与 CI 保留。                                                             |
| 当前阶段   | **Windows 功能开发与安装版验收进行中**：`f7771d9` 主线四项 CI、两种 Counter 与 Runtime 构建通过；Windows 10 覆盖 13 项维护，Windows 10/11 两种发行的四条柜台核心旅程分别通过。IME、修正 GUI、系统生命周期和软件打印结果见[交付记录](docs/operations/2026-10-01-windows-full-feature-delivery.md)，尚未完成全功能验收。                                                                        |
| 设计真源   | [ADR-71](docs/adr/2026-10-02-adr-71-cloud-platform-pause.md) · [ADR-66](docs/adr/2026-08-29-adr-66-windows-hongfa-pilot.md) · [Windows 实机 findings](docs/research/2026-08-29-windows-port-findings-and-build-host.md) · [ADR-16](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md) · [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md) |
| 当前 owner | **Codex** — 设计、实现、集成与门禁                                                                                                                                                                                                                                                                                                                                                            |
| 目标平台   | Windows 10 22H2 / Windows 11 x64 的活动 V2 Electron NSIS `.exe` 与本机 Runtime；当前产物为未签名合成开发版，实体打印和正式签名单独验收。                                                                                                                                                                                                                                                      |

本机保留的开发版产物位于 `dist/windows-f7771d9-20261003/`，含两份 Counter 安装程序、两份完整
Runtime ZIP 与摘要索引 `delivery.json`；安装版验收仍在进行，该目录不是正式发布渠道。
该目录原 Runtime ZIP 的管理窗口已发现语法错误，暂不作为已完成版本。`candidate-runtime10/`
提供修正 `.10` 完整候选及来源说明；原生解析回归已通过，实际安装和窗口复验尚待完成。
IME4 已在 Windows 11 的通用版与宏发版分别通过真实输入验收，每版各 1 项通过、无失败或跳过，
控制器正常退出且双管道关闭。此前 IME 失败记录保留，旧打印前置失败进程已受控回收。
软件打印和 `.9/.10` 剩余验收也尚未通过；实际覆盖及剩余清单见上述交付记录。

以下 Cloud 能力与部署证据为暂停前的历史基线，不构成当前开发或部署计划：

已交付到 hk-vps 的代码面包括 `Local Foundation → 完整柜台工作日 → 履约/顾客/员工治理 → 本地备份恢复 → 加密离线队列与 Primary → 重放对账 → 会员储值二期 → 催取人工名单 → 双口径账目 → 会员账户生命周期 → LAN Owner → Runtime 数据保护/升级 → 正式候选软件证据 → 服务端权威计价/支付退款/件级挂单恢复 → 价目恢复/原子排序/乐观版本/安全审计 → Owner 云端经营与门店管理 → 会员权益与有效期 → 顾客扩展档案与折扣政策 → 云数据保护与联合恢复 → provider-neutral 通知 outbox → 店厂交接与质检 → 取送全链与移动任务面 → 营销活动/券/推荐团购 → 顾客自助订单与钱包 → AI/BYOK 有界只读与自动化`。阶段 5.0 的新鲜证据包含 exact-main `c8919af3…f35a`、公网 API 20/20、Cloud Chromium PASS、marker/0069、四服务/共享站点健康及 release-set inventory/preflight；该环境仍禁止真实顾客 PII，也不等于生产 SaaS。AI/BYOK 与通知 provider 当前只有 `software_only` 证据，不声称已发送、已送达或已产生真实模型调用。当前 macOS 新鲜证据只属于 **software-only**，不冒充 XP-58 实体打印、Developer ID/公证、正式双架构 OCI、Windows 实机或生产云证据。

宏发 v1 版本仍停止开发；根 `src/` 只作为历史行为参考。宏发现在是通用 V2 Windows 发行 profile 与受控试点对象。

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

`W0 Windows 安全基座 → W1 Windows EXE/打印 → W2 生产与迁移准入 → W3 宏发受控运营`

当前执行入口是[Windows 功能交付与安装版验收记录](docs/operations/2026-10-01-windows-full-feature-delivery.md)，
本机 Runtime 的开发与维护说明见 [Windows Runtime 指南](tools/windows-runtime/README.md)。
完成状态分别记录源码与 CI、构建产物、Windows 安装和实际验收结果；旧版通过不替代当前版本实测。
真实 provider 必须有获授权的 sandbox 或正式回执，软件 fake 只能证明 `software_only`。
[阶段 5 生产化交付计划](docs/superpowers/plans/2026-08-17-stage5-productionization-plan.md) 的 Cloud 工作已暂停。
阶段 1–4.5 已完成基线及历史 [Cloud Web-first 1–4 计划](docs/superpowers/plans/2026-08-10-post-adr36-delivery-plan.md)、
[ADR-36 Web 产品收口计划](docs/superpowers/plans/2026-08-09-adr36-web-product-convergence-plan.md)、
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

hk-vps 现状冻结，不做新部署。历史云测试部署、回滚、登录 smoke 和维护重启见
[ADR-36 运维手册](docs/operations/2026-08-09-hk-vps-cloud-test.md)；历史已完成发布见
[阶段 1 结果](docs/operations/2026-08-11-stage1-release-result.md)与
[阶段 2 结果](docs/operations/2026-08-11-stage2-release-result.md)、
[阶段 3.1 结果](docs/operations/2026-08-11-stage3-catalog-governance-release-result.md)与
[阶段 3.2–4.5 结果](docs/operations/2026-08-13-stage32-45-release-result.md)与
[非部署批次与白屏修复结果](docs/operations/2026-08-14-nondeploy-batches-release-result.md)与
[归档工具修复结果](docs/operations/2026-08-15-artifact-archive-release-result.md)及
[阶段 5.0 发布解阻与关闭结果](docs/operations/2026-08-25-stage50-release-result.md)。

## License

私有项目（manpengan 个人所有）。
