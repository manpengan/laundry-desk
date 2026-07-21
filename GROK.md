# GROK.md — laundry-desk

Grok 在本项目中的入场指引。

## 你的角色

**受约束协助实现线**：在 Codex 冻结的 contracts/ports 下负责 `apps/web`、`packages/ui`、Edge 平台 adapters、打包、硬件驱动与实机/黑盒证据。Codex 是设计与核心实现的单一负责人。

当期任务书：[docs/superpowers/plans/tasks/2026-07-21-task-grok-assist.md](docs/superpowers/plans/tasks/2026-07-21-task-grok-assist.md)

## 入场必读

1. [v2 架构 spec](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)（定稿真源）
2. [v2 Web UI spec](docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md)
3. [总 RFC + ADR-01…08](docs/adr/2026-07-19-v2-productization-and-ai.md)（全部 Accepted；设计变更走新增 ADR，不回改）
4. [单一技术负责人治理](docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md)
5. `~/.claude/rules/common/coding-style.md` 代码红线

## 红线（违反即 PR 拒收）

- 文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层、金额全程整数分禁浮点、不可变优先
- **Edge 内不写业务校验逻辑**——校验语义全部在 server 命令总线，Edge 只是受约束的执行与暂存端（ADR-01）
- **浏览器不持有敏感状态**：设备私钥只在 OS 凭据区；IndexedDB 只缓存 UI/字典，不存交易/审计
- **Electron 安全基线硬性达标**：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、最小 preload、禁任意导航/新窗口/外链、权限默认拒绝
- 金额渲染一律 `MoneyText` 组件；状态色 = 颜色+图形双编码
- 不改 `apps/server`、`packages/domain`、contracts 公共形状或 Edge 安全核心；跨模块需求提交给 Codex
- 动 git 前先探测他人活跃编辑（多 AI 共用 checkout）；不直接推 main
- 种子/测试数据一律虚构（手机号用 13800000xxx 段），禁止任何真实客户 PII

## 协作流程

- 契约以 `packages/contracts` 冻结组/tag 为唯一来源；期内改契约由 Codex 走 ADR
- PR：带契约测试 + 门禁自查清单；Codex 验收；安全语义与核心代码由 Codex 提供，Grok 只接 platform adapters
- 每周五集成日全量 E2E；commit 尾行 `Co-Authored-By` 署名自己
