# ADR-10: 单一技术负责人 + 受约束协助线

- 日期：2026-07-21
- 状态：**Accepted**（manpengan 选择方案 A）
- 详设：[单一技术负责人交付治理](../superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md)
- 触发：M1 实装盘点发现四 AI 分工产生契约等待、目录锁、半成品支线和多份状态真源；manpengan 裁定后续设计与开发由 Codex 负责，Grok 协助。

## 决策

1. Codex 是 laundry-desk v2 后续设计、核心实现、集成与门禁的单一技术负责人。
2. Grok 是受约束协助线，只在 Codex 冻结的 contracts/ports 下负责 Web/UI、Edge 平台 I/O、硬件适配、Windows 实测和黑盒回归。
3. Claude/Gemini 退出实现和冻结关键路径；已合入资产保留，未合分支只作候选输入，可选复审不得阻塞交付。
4. manpengan 保留产品裁决、外部环境协调和最终 PR 合并权。
5. 2026-07-19 的四 AI 分工只保留为历史记录；本 ADR 覆盖其中所有未完成项的 owner、依赖和验收关系。

## 理由

- contracts、PG/RLS、Command Bus、审计、identity 和 Policy 是一条纵向安全链，拆给多方会在接口冻结前产生支线实现和重复返工。
- Codex 已负责 M0-1/M0-2、A1/A2/A4，并承担安全与基座，继续统一承担核心链的上下文切换成本最低。
- Grok 已交付的有效资产集中于 UI、Electron 壳、升级状态机和打印 spike，适合在冻结接口下承担端侧和硬件适配。
- 单一负责人不取消独立证据：main CI、硬件实测、Windows 演练、迁移差异报告仍是不可替代的验收源。

## 否决的备选

- **仅把旧任务书里的名字替换为 Codex/Grok**：保留双真源、目录锁和交叉等待，问题未解决。
- **推倒 M1 重来**：会浪费 A1/A2/A4、B1/B3、E2 与 Edge 骨架的有效成果。
- **Codex 与 Grok 共同拥有 Edge 安全目录**：共享所有权会重现冲突；改用 core ports 与 platform adapters 的单向边界。

## 后果

- 架构 spec §15、M0/M1 与 M2—M6 实施计划的旧四 AI 分工均由本 ADR 覆盖。
- 新增 Codex lead 与 Grok assist 当前任务书；旧任务书顶部标注 superseded，但保留历史内容。
- Codex 维护 contracts、domain、server、PG/migrations、迁移工具和 Edge 安全核心。
- Grok 维护 Web/UI、Edge platform/drivers/packaging，并消费 Codex 冻结的接口。
- 最终合并仍由 manpengan 执行，避免技术负责人同时成为唯一验收与发布授权人。
