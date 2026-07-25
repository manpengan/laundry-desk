# ADR-14：通用 V2 本地优先交付与 Codex 接管

- 日期：2026-07-25
- 状态：**Accepted**
- 决策者：manpengan
- 详细设计：[通用 V2 本地优先产品设计](../superpowers/specs/2026-07-25-local-first-v2-product-design.md)
- 设计基线：
  - [Claude V2 architecture draft3.1a](../superpowers/specs/2026-07-19-laundry-v2-architecture.md)
  - [Claude V2 Web UI draft3.1a](../superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md)
  - [Liquid Glass UI 2.0](2026-07-18-liquid-glass-ui-2.md)

## 背景

ADR-13 已终止 v1 功能线，但其下一交付目标仍是“宏发升级候选版”，并把 v1
迁移、离线 Edge、真实打印、AI/BYOK 和 Windows 证据同时放在 V2-M2 关键路径。
该范围不再符合当前产品裁决。

manpengan 在 2026-07-25 明确：

1. 宏发版本不再继续，直接做面向任意洗衣店的通用新方案；
2. 后续开发交由 Codex 推进；
3. 优先完成本地 Web Server 与 macOS App 测试；
4. 全部产品开发完成后，再部署云服务器并适配 Windows；
5. 新方案必须建立在 Claude 最新定稿的新框架上，不重写现有 V2 基座。

## 决策

### 1. 活动产品线

- 继续坚持 **V2-only**，活动代码仍仅位于 `apps/`、`packages/` 和 V2 工具。
- 下一交付物改为**通用 V2 本地产品版**，不再以宏发门店、宏发数据迁移或宏发
  包装为发布目标。
- 根 `src/` 与 v1 SQLite 继续冻结，仅作历史行为参考；v1 迁移器保留但退出当前
  关键路径。

本条覆盖 ADR-13 第 5、6 条的“宏发升级候选版”和迁移优先级，不改变 ADR-13
关于 V2-only 与冻结 v1 的其余裁决。

### 2. 交付责任

- Codex 接管后续设计真源、实现、集成、质量门禁与交付推进。
- manpengan 保留产品裁决、外部环境与最终仲裁。
- Grok/Claude/Gemini 的未合分支仅作候选输入，不直接并入；已合入 `main` 的成果
  正常复用。
- `origin/main` 继续是代码真源；Gitea 不进入本轮提交或发布链路。

本条覆盖 ADR-12 与现行治理文件中的 Grok owner 分配。

### 3. 技术框架

不创建第二套框架。继承 Claude draft3.1a 的：

- pnpm/Turborepo monorepo；
- React/Vite 共用 SPA；
- `packages/ui` Liquid Glass 设计系统；
- Fastify + PostgreSQL 16 + RLS；
- Zod 契约、统一 Command/Query Bus、RBAC、审计与整数分金额；
- Electron `app://` 本地资产与安全基线。

### 4. 交付顺序

1. **本地 Web + macOS**：独立运行的 localhost Fastify/PG、本地浏览器、macOS
   Electron 壳、完整柜台工作日、模拟打印。
2. **产品功能补齐**：在同一架构上继续会员、通知、AI、真实硬件等后续能力。
3. **最终部署与适配**：核心产品开发完成后再做云服务器部署与 Windows 打包/实机
   适配。

当前阶段不提前实现云同步、离线队列、Primary lease、真实打印机、AI/BYOK、
v1 迁移或 Windows 包装。

### 5. 首个里程碑

首个里程碑是**本地单机完整柜台工作日**：

- 密码登录与 PIN 员工切换；
- 顾客查询/建档；
- 开单、权威计价、折扣、收款、欠款、挂单与撤销；
- 订单列表/详情；
- 整单或部分取衣，取衣时补款，独立欠款补缴；
- 今日统计与交班结账；
- 可观察、可失败、可重试的文件型模拟打印；
- 同一 React UI 在浏览器和 macOS App 运行。

验收使用真实 PostgreSQL；memory runtime 只保留给快速单元测试。

## 后果

- 当前已实现的 contracts/domain/server/web/edge 基座继续复用，优先修复账本、
  幂等、并发、认证和营业日等可信性断层。
- 所有 `hongfa` 产品硬编码、旧产品名和旧默认包装必须从活动 V2 路径移除。
- Electron 壳必须加载 `apps/web` 的真实构建产物，不能继续使用独立占位 SPA。
- macOS 首轮允许本地开发/未公证测试包；正式签名、公证与自动更新随最终发布阶段
  处理。
- Claude draft3.1a 中 AI-first、离线、迁移和 Windows 的原里程碑顺序由本 ADR
  覆盖，但其安全模型、模块边界和未来接口仍保留。

## 否决的备选

- **重写一套本地桌面应用**：会复制业务逻辑并破坏未来上云路径，否决。
- **继续把宏发迁移作为首个门禁**：与通用产品裁决冲突，否决。
- **先做云或 Windows**：扩大外部环境与发布面，延后本地业务闭环，否决。
- **把 Fastify/PG 嵌入 Electron**：增加生命周期、升级和数据恢复耦合，否决。
- **首期同时做离线与真实硬件**：无法快速证明柜台业务正确性，否决。
