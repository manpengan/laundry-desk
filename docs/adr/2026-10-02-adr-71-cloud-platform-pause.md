# ADR-71：Cloud 平台暂停开发与部署

- 日期：2026-10-02
- 状态：**Accepted**（治理类；manpengan 会话书面裁决后落档）
- 决策者：manpengan（2026-10-01 会话：“取消云平台开发和部署”；2026-10-02 会话确认：
  “云平台先暂停，不再开发，你把这个在项目先备注记录”）
- 前序：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)、
  [ADR-64：阶段 5 生产化接续](2026-08-17-adr-64-stage5-productionization-and-release-retention.md)、
  [ADR-65：Cloud 生产基线](2026-08-25-adr-65-cloud-production-baseline.md)、
  [ADR-66：Windows V2 定制桌面版与宏发受控运营试点](2026-08-29-adr-66-windows-hongfa-pilot.md)
- 影响：活动路线、阶段 5.1/5.2 Cloud 工作、`hk-vps-cloud-test`、ADR-66 的 W2/W3 准入前置条件

## 背景

ADR-66 已把活动主线改为 Windows V2 定制 EXE → 宏发受控试点，但仍把 ADR-65 的 Cloud 独立生产
环境、离机恢复、告警、容量与真实数据准入列为试点前置条件。2026-10-01 起 manpengan 在会话中明确
取消云平台开发和部署，此后 Codex 的本轮 Windows 交付已按此执行；该裁决此前只写在 `task_plan.md`
一行，`AGENTS.md`、ADR 索引与 ADR-66 的前置条件表述仍按 Cloud 继续推进书写，入场 agent 会读到
相互矛盾的路线。

## 决策

### 1. Cloud 平台进入暂停状态

自 2026-10-01 起，以下工作**暂停，不再开发、不再部署**：

- ADR-37 Cloud Web 交付线的新增功能与发布；
- ADR-64/65 的阶段 5.1 Cloud 生产基线与阶段 5.2 准入工作；
- 任何 Cloud 生产或 production-candidate 环境的建设、迁移与上线。

这是**暂停**，不是废弃：已合入 `main` 的 Cloud 相关代码、契约、迁移与 CI 保持原样，不为暂停而删除；
现有 CI 继续守护共享代码不回归。Cloud 相关文档保留为历史与恢复时的基线。

### 2. `hk-vps-cloud-test` 现状冻结

不向 `hk-vps-cloud-test` 做新部署；既有约束（仅合成数据）不变。该主机是否停机或回收不在本 ADR 范围，
由 manpengan 另行裁决；在此之前不主动变更其运行状态。

### 3. Windows 本地交付继续为唯一活动主线

ADR-66/67/68/69/70 的 Windows V2 本地安装版、本机 Runtime、托管备份恢复与发行 profile 继续推进。
共享代码（`apps/server`、`apps/web`、`packages/*`）的改动仍须保持现有 CI 全绿，不得以“Cloud 已暂停”
为由跳过既有测试或放宽边界。

### 4. 宏发真实数据准入的前置条件需另立 ADR

ADR-66 W2 末项与 W3 依赖 ADR-65 的 Cloud 门禁。Cloud 暂停后，这一前置条件**没有被取消，也没有被替代**：

- 在新的 ADR 明确纯本机形态的生产准入门禁（至少覆盖离机备份介质与恢复演练、故障告警、容量、
  宏发 v1 只读迁移演练、切换/回退手册与数据责任）之前，**宏发仍不得导入真实顾客数据**；
- Windows 软件验收（安装、升级回滚、自启、IME、打印等）不受影响，可继续推进。

### 5. 恢复条件

Cloud 平台恢复开发须由 manpengan 明确裁决，并新增 ADR 说明恢复范围与 ADR-65 门禁的接续方式；
不得由 agent 依据旧计划自行恢复。

## 理由

- 当前唯一交付目标是宏发门店的 Windows 本地运营，Cloud 工作不在其关键路径上，继续推进只消耗带宽。
- 暂停而不删除，保留已验证的共享代码与 CI 守护，恢复成本最低。
- 显式写明“真实数据准入前置条件需另立 ADR”，避免把 Cloud 暂停误读为生产门禁一并取消。

## 否决的备选

- **只在 `task_plan.md` 记录**：入场 agent 以 `AGENTS.md`/ADR 为准，会继续按 ADR-65 推进 Cloud。
- **删除 Cloud 代码与 CI**：破坏共享代码的回归守护，且恢复成本高。
- **随暂停一并免除 ADR-65 门禁**：会让宏发在没有离机恢复与告警的情况下导入真实数据。

## 后果

- `AGENTS.md`、`CLAUDE.md` 与 ADR 索引同步注明 Cloud 暂停。
- ADR-37/64/65 正文不回改，以本 ADR 为暂停依据。
- 待办：新增“Windows 本机形态生产准入”ADR，替代 ADR-66 中对 ADR-65 的依赖后，才能进入 W3。
