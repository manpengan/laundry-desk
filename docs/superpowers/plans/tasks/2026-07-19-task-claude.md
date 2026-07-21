# laundry-v2 开发任务书 · Claude（设计与门禁）

> **Superseded for unfinished work by ADR-10**。Claude 已退出设计、冻结和验收关键路径；本文仅保留历史责任与既有门禁资产出处。

> 下发：manpengan　日期：2026-07-19
> 覆盖：V2-M0 + V2-M1 的设计、契约、门禁与评审工作（Claude 不写实现代码——CLAUDE.md 既定边界）
> 完成定义：契约按期冻结、门禁资产交付、各包验收结论落档。

## 0. 入场必读

设计真源与决策链自己起草的不再列；每次验收前重读：`~/.claude/rules/common/coding-style.md`、各任务书（codex/gemini/grok）、`docs/adr/` 全部 Accepted ADR。

## 1. 职责边界

- **拥有**：`packages/contracts` 的语义与评审权（Zod 由 Codex 落地）、`docs/`（specs/plans/adr/research）、门禁资产、每包 PR 验收
- **禁止**：改 `src/`、`apps/`、`packages/domain|ui` 实现代码；装依赖；跑 `pnpm build`（2026-07-19 的 CI 卫生修复为 manpengan 单次授权的例外，不构成先例）

## 2. M0 阶段任务

- [ ] T1 **M0 门禁规格**：为六项 spike 各写一页验收单（目标/步骤/通过标准/证据格式），发给对应 AI 随任务执行
- [ ] T2 **findings 门禁评审**：六项证据齐后评审 `docs/research/2026-07-19-v2-m0-findings.md`，逐项给 通过/不通过/需改设计 结论；任何"需改设计"→ 起草新增 ADR（不回改已 Accepted 正文）
- [ ] T3 **M0 期间答疑**：各 AI 对 spec 的歧义提问，24h 内以 spec 补丁或 ADR 澄清（澄清也走文档，不走口头）

## 3. M1 阶段任务

- [ ] T4 **contracts@v0.1.0 冻结**（与 Codex 结对）：逐条评审 A1–A7 的 Zod 实现与 spec 语义一致性（命令元数据四字段、R0–R5、三元租户矩阵、USING+WITH CHECK 模板、lease 签名对象、队列信封版本、会话/CSRF）；通过即打 tag；期内变更一律走 ADR
- [ ] T5 **门禁资产**（交给对应 AI 执行、我验收）：
  - AI 红队用例集 ≥20 条（备注藏指令/图片藏文字/工具参数越权/跨租户诱导/R5 诱导等），断言"不产生未授权工具调用"
  - 跨租户五类旁路负向用例规格（M0-1 转正为 CI 门禁）
  - 确认卡 WYSIWYS E2E 断言规格（换参作废/过期不可执行/canonical 冻结/step-up 不可自核）
  - 每包 PR 验收 checklist 模板（含 Electron 安全基线自查表）
- [ ] T6 **每包 PR 验收**：对照门禁逐项给结论；高危触发点（RLS/审计/Policy/lease/Edge 密码学/鉴权）确认已过 Codex 二审才放行
- [ ] T7 **M1 集成门禁**：周五集成日全量核验（契约测试/负向测试/红队/WYSIWYS/Playwright 核心路径），出验收报告
- [ ] T8 **M2 计划编制**：M1 过半时产出 M2 同粒度计划与任务书增量（柜台核心 + 只读 AI + BYOK 最小闭环），冻结 contracts v0.2 增量范围

## 4. 持续职责

- 文档一致性：spec/ADR/README/CHANGELOG 同步；`docs/CHANGELOG.md` 自 M1 起建立并维护
- 协作仲裁：目录所有权冲突、契约争议的第一裁决人（技术分歧升级 manpengan）
- 隐私红线看守：任何 PR 引入客户 PII 样本/截图/真实手机号即拒（种子数据一律虚构号段）

## 5. 时序

```text
M0 开工日: T1 六份验收单发出 → M0 期间: T3 答疑 → M0 收口: T2 findings 门禁
M1 首日: T4 contracts 冻结 → 并行: T5 门禁资产 + T6 逐 PR 验收 → 每周五: T7 → M1 过半: T8
```
