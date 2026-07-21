# ADR-12: Grok 统一交付所有权（设计 + 实现）

- 日期：2026-07-21
- 状态：**Accepted**（manpengan 口头/会话授权「后续设计与实现由 Grok 统一完成」，本 ADR 落档）
- 详设：[单一技术负责人交付治理](../superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md)（由本 ADR 修订 owner）
- 覆盖： [ADR-10](2026-07-21-adr-10-single-owner-delivery-governance.md) 中**未完成职责的 owner 分配**（不回改 ADR-10 正文决策句，见状态栏）
- 触发：M1 中段（A1–A5 已合入 main）后，manpengan 要求后续设计与实现统一由 Grok 完成，消除 Codex 单 owner 与端侧协助线的二次分工成本。

## 决策

1. **Grok 是 laundry-desk v2 后续设计、核心实现、集成与门禁的单一技术负责人**（含 contracts / domain / server / PG / Edge core / Web·UI 策略与实现顺序）。
2. **Codex / Claude / Gemini 退出关键路径**；已合入 main 的成果继续有效；未合分支只作候选输入；可选非阻塞复审，无冻结权与合并前置权。
3. **manpengan** 保留产品裁决、外部环境（API key / Windows / 打印机）、ADR 签署与最终仲裁；**授权 Grok 在 required checks 与门禁满足后执行 PR 合并**，并必须复核合入后 main 双 workflow。
4. **不以推倒重做为默认**：`origin/main` 为唯一代码真源；A1–A5 等已合入契约与骨架只演进、不废弃。
5. **模块边界仍建议保留**（`edge-agent` 的 core vs platform/drivers 等）作为代码组织，但 **owner 均为 Grok**，不再跨 AI 等待 ports。
6. 2026-07-19 四 AI 分工与 ADR-10 的 Codex-lead / Grok-assist 任务书均 **superseded** 为本 ADR + 当前 `GROK.md` / `task-grok-lead`。

## 理由

- 契约冻结（A1–A5）已过半，剩余主线是 **A6→db→Bus→Identity→Edge/Web 闭环**；再拆「冻 ports / 接 adapters」会人为串行。
- Grok 已在 main 上交付 UI、Electron 壳、升级骨架、驱动渲染与 lab 清单，并具备继续全栈推进的会话授权。
- 单一负责人仍服从独立证据：main CI、负向测试、硬件/Windows 实机、迁移差异报告不可被「自审自合」替代为口头通过。

## 否决的备选

- **继续 ADR-10（Codex lead + Grok assist）**：与当前授权冲突，端侧仍空等 ports。
- **推倒 M1 重写契约**：浪费 A1–A5 与 M0 证据。
- **仅改入口文件不写 ADR**：产生双 owner 真源，回归 ADR-10 要解决的问题。

## 后果

- ADR-10 状态标为 **Superseded by ADR-12**（正文保留历史）。
- 入口：`GROK.md` / `AGENTS.md` 指向 Grok lead；Claude/Gemini 顶部标明退出关键路径。
- 任务书：`2026-07-21-task-grok-lead.md` 为当前；codex-lead / grok-assist 标 superseded。
- 实施顺序沿用接管计划 P1–P4，**执行者改为 Grok**。
- 下一功能默认从 **A6 首批命令** 起，不夹在本治理 PR 内。
