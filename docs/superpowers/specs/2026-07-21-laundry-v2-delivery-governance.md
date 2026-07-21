# laundry-desk v2 单一技术负责人交付治理

> 日期：2026-07-21  
> 状态：**Approved（ADR-12）** — Grok 统一设计与实现；ADR-10 的 Codex-lead 分配已覆盖  
> 适用范围：V2-M1 未完成项及 V2-M2—M6 后续设计、实现与验收  
> 覆盖关系：本文件覆盖架构 spec §15、M0/M1 计划 §3、M2—M6 计划 §6 以及 2026-07-19 四 AI / ADR-10 协助线中尚未完成的职责分配；历史事实和已合入成果不改写。

## 1. 决策

自 **ADR-12** 生效起：

1. **Grok 是单一技术负责人**，负责后续设计真源、ADR、契约、核心实现、安全边界、集成顺序、测试门禁和交付证据。
2. **Codex / Claude / Gemini 退出实现与冻结关键路径**；已合入成果继续有效，未合并分支和文档草稿只作为候选输入。可选非阻塞复审，无等待依赖、冻结权或合并前置权。
3. **manpengan** 保留产品裁决、外部凭据/硬件协调与最终仲裁；**授权 Grok 在 required checks 与验收门禁满足后执行 PR 合并**，并必须复核合入后 main。
4. 不以推倒重做为默认：`origin/main` 为唯一代码真源。

本决策解决的问题：在契约已过半（A1–A5）后，避免「冻 ports / 接 adapters」二次分工造成空转，让一条纵向链对设计、代码与证据同时负责。

## 2. 事实基线（交接签收，2026-07-21）

基线：`origin/main` 含 A1–A5 合入之后的 tip（以 fetch 时 tip 为准）。状态只按 main、PR、CI 和可复现实跑判定。

| 分类 | 当前内容 |
| --- | --- |
| 已合入并可复用 | A1 注册表、A2 信封/错误、A3 租户/RLS **契约**、A4 Edge 协议、A5 会话/CSRF/PIN **契约**、B1/B3、E2 UI、D1/D5 骨架、web 壳、F2 seed、F3 mock compose、lab 清单 |
| 部分实现 | D1 缺签名 SPA 与 Windows 证据；D5 缺 updater I/O；F3 仍 mock server；A3/A5 的 **runtime** 未转正 |
| 未实现 | A6/A7、B2/B4、C1–C8、F1、D2/D3 正式、E1/E3、packages/db 生产 migrations |
| 仅候选输入 | `feat/m1-c7-platform` 内存 C7；`claude/m1-gates` A6 草稿；各远端 AI worktree 未合 diff |
| 治理 | 无 `contracts@v0.1.0` tag；ADR-09 仍 Proposed；正式 v2 PG schema 不存在 |

六档状态：已设计 / 已编码 / 已开 PR / 已合 main / CI 绿 / 实机通过。

## 3. 责任边界

### 3.1 Grok 主责（全部关键路径）

- 架构 spec、ADR、contracts 版本和里程碑实施计划；
- `packages/contracts`、`packages/domain`、`packages/ui`（实现与演进）；
- `apps/server`、`apps/web`、`apps/edge-agent` 全栈；
- v2 PostgreSQL schema、migrations、RLS、角色与事务；
- Command Bus、审计、Tool Registry、Policy、确认卡、step-up；
- identity、session、CSRF、PIN、RBAC 与 actor/tenant 注入；
- Edge 协议与安全核心 **以及** platform/drivers/packaging；
- 迁移工具、seed/compose 正式集成、门禁与实机证据组织。

### 3.2 模块边界（组织，非跨 AI 锁）

Edge 仍建议目录：

- `core/` / `security/` / `queue/` / `lease/` — 协议与安全状态机；
- `platform/` / `drivers/` / `packaging/` — OS/硬件 I/O。

公共类型优先进 `packages/contracts`。Web API client 在 A7 后只消费生成类型。

### 3.3 历史 AI 资产

- 已进 main 的代码与门禁结论正常维护。
- 未进 main 的分支不得直接合并；提取测试意图后按当前架构重写。

## 4. 真源与变更纪律

优先级从高到低：

1. manpengan 的书面/会话裁决；
2. Accepted ADR（含 ADR-12）与本治理文件；
3. 当前架构 spec；
4. 当前里程碑实施计划和 **Grok lead 任务书**；
5. contracts 代码与版本 tag；
6. PR 描述、验收单、代理报告。

- 已 Accepted ADR 不回改正文；新决策写新增 ADR。
- contracts 每组可独立冻结并解闸；A1–A7 全绿且 ADR-09 签署后打 `contracts@v0.1.0`。

## 5. 接管后执行顺序（执行者 = Grok）

### P0：治理

1. 合入 ADR-12 与入口/任务书/status 刷新（本变更）。
2. 请 manpengan 签署 ADR-09（未签不打最终 contracts tag）。

### P1：契约与纯函数

A6 → A7 → B2 → B4 →（可选）`contracts@v0.1.0`。

### P2：PG 与 server

`packages/db` → C2 → C1+C3 → C6+C8 → C5 → C4+C7。

### P3：Edge / Web 闭环

D2/D3/D4 正式、D1/D5 证据与 I/O、E1/E3（可与 P2 部分并行，但身份页依赖 C6）。

### P4：集成收口

真实 compose、F1 试跑、全门禁绿，再开 M2 柜台业务。

## 6. 合并与证据

- PR：小步、可复现测试；required checks 绿后 Grok 可合并，并复核 main。
- 禁止：无实测写「通过」；`|| echo PASS`；只改一侧 lockfile。
