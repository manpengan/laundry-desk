# M1 门禁资产索引（contracts 冻结 + 逐包验收）

> 起草：Claude（历史门禁）　日期：2026-07-20　当前维护：**Grok（ADR-12，2026-07-21）**
> 用途：T4 contracts@v0.1.0 逐组冻结评审 + T5 门禁资产 + T6 逐 PR 验收的统一入口。

## A1–A7 契约冻结评审单（当前由 Grok 维护，逐组过）

| 组  | 评审单                                                 | 状态                                                                                                                                 |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | [命令/查询注册表 schema](a1-command-registry.md)       | **✅ 已冻结**（[冻结结论](2026-07-20-a1-freeze-verdict.md)；6 必修已由 PR #43 闭环，含 F7/F12）                                      |
| A2  | [统一信封 + 错误码表](a2-envelope-and-errors.md)       | **✅ 已冻结**（[冻结结论](2026-07-20-a2-freeze-verdict.md)）。C7 在 A6+C1 后由 Grok 实现                                           |
| A3  | [租户表矩阵 + 三元组合键 + RLS 模板](a3-tenant-rls.md) | **✅ 已冻结**（PR #56 合入；contract-only；正式 migration 与五类旁路实跑留 C2/P4）                                                 |
| A4  | [Edge 桥协议类型](a4-edge-bridge-protocol.md)          | **✅ 已冻结**（PR #53）；canonical、签名线品牌、grant 子集与 queue replay tuple 均有机制测试                                     |
| A5  | [会话/CSRF 契约](a5-session-csrf.md)                   | **✅ 已冻结**（PR #58 合入；contract-only；C6/C8 runtime 仍是缺口）                                                               |
| A6  | [首批命令 identity/platform](a6-first-command-definitions.md) | **✅ 已冻结（本 PR）** — 9 定义；secret≠R5；settings.set=R5；587 contracts tests |
| A7  | zod-to-openapi + OpenAPI 快照进契约测试                | 待发                                                                                                                                 |

**逐组节奏**：每完成一组即合入并提交可复现证据，不攒批。

**放行语义（manpengan 裁定；ADR-12 后由 Grok 维护）**：tag `contracts@v0.1.0` 是最终封版标记，不是放行闸。每组评审通过并合入即冻结、下游可依赖；七组全绿且 ADR-09 已签署后打 tag。

| 组冻结           | 解闸的下游                          |
| ---------------- | ----------------------------------- |
| A2 信封 + 错误码 | 全队错误处理；C7（另需 A6+C1）      |
| A4 Edge 桥协议   | D2 配对 / D3 加密队列 / D4 打印回执 |
| A5 会话/CSRF     | E1 登录页（另需 C6 runtime）        |
| A6 首批命令定义  | C6/C7、E3（另需 A7）                |

**注**：D1/D5 已合入但仍是骨架；B1/B3/F2/F3 已由 PR #48 合入。历史解闸提示词不再承担当前调度职责。

## T5 门禁资产（我出规格、对应 AI 执行、我验收）

| 资产                             | 规格                                                       | 执行方              | 状态     |
| -------------------------------- | ---------------------------------------------------------- | ------------------- | -------- |
| 每包 PR 验收 checklist 模板      | [pr-checklist-template.md](pr-checklist-template.md)       | 全员自查            | **已出** |
| 跨租户五类旁路负向用例 → CI 门禁 | [t5-cross-tenant-ci-gate.md](t5-cross-tenant-ci-gate.md)   | Codex（随 C2 交付） | **已出** |
| AI 红队用例集 ≥20 条             | 待出——**依赖 A1 的 Tool Registry 投影形状**，A1 通过后即出 | Codex（C4/C5 消费） | 待发     |
| 确认卡 WYSIWYS E2E 断言规格      | 待出——**依赖 A1/A2 的确认卡契约形状**，两组通过后即出      | Codex（C5）         | 待发     |

## 四条本期红线（M0 实测教训，已写入 PR checklist）

1. **证据强度 ≥ 结论强度**——无实测证据不得写"通过"；没跑就写"待实测"。（M0-5 判负主因：mock 输出删掉横幅冒充实测）
2. **提交前 rebase**——`git fetch origin && git rebase origin/main`。（M0 期间有人在过时工作树提交，覆盖了 main 已有的 CI 修复）
3. **断言必须能失败**——`|| echo PASS` 式恒真断言一律打回；写完先人为破坏一次确认它会红。（M0-6 Test 4 判负原因）
4. **双锁文件同步**——增删依赖必须同时更新 `package-lock.json` 与 `pnpm-lock.yaml`，否则两条 CI 线必红一条；装依赖前先查 peer 兼容性。（#38 已踩）

## 争议与澄清（T3 值守，24h 内书面回应）

spec 歧义一律以**新增 ADR** 或 spec 补丁澄清，已 Accepted 的 ADR 正文不回改。本期已出：

- [ADR-09 命令元数据字段精确化](../../../../adr/2026-07-20-adr-09-command-metadata-precision.md)（Proposed，待签署；**含修订 1**）——`offline_allowed` 三值化；`max_batch` 拆 `size_measures`（怎么算）/ `hard_limits`（超即拒）/ `risk_escalation`（超即升 R4）三字段。**A1 按此落地，勿按 §6.5 字面。**修订 1 采纳自 Codex A1 设计稿指出的求值缺口。
