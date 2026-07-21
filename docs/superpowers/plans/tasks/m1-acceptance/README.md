# M1 门禁资产索引（contracts 冻结 + 逐包验收）

> 起草：Claude（历史门禁）　日期：2026-07-20　当前维护：Codex（ADR-10，2026-07-21）
> 用途：T4 contracts@v0.1.0 逐组冻结评审 + T5 门禁资产 + T6 逐 PR 验收的统一入口。

## A1–A7 契约冻结评审单（当前由 Codex 维护，逐组过）

| 组  | 评审单                                           | 状态                                                                                                                                 |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | [命令/查询注册表 schema](a1-command-registry.md) | **✅ 已冻结**（[冻结结论](2026-07-20-a1-freeze-verdict.md)；6 必修已由 PR #43 的 `875ae3c` 闭环，含 F7/F12）                         |
| A2  | [统一信封 + 错误码表](a2-envelope-and-errors.md) | **✅ 已冻结**（[冻结结论](2026-07-20-a2-freeze-verdict.md)：0 必修 / 1 记录；§2.1–§2.6 全部以机制实现）。C7 由 Codex 在 A6+C1 后重写 |
| A3  | 租户表矩阵 + 三元组合键 + RLS 模板               | 待发（**直接采信 M0-1 实测底稿，不重新设计**）                                                                                       |
| A4  | [Edge 桥协议类型](a4-edge-bridge-protocol.md)    | **✅ 已冻结**（PR #53 / `a051b5e` 合入）；canonical、签名线品牌、grant 子集与 queue replay tuple 均有机制测试                        |
| A5  | 会话/CSRF 契约                                   | 待发                                                                                                                                 |
| A6  | M1 首批命令定义（identity/platform）             | 待 Codex 开工；旧 `claude/m1-gates` 仅作草稿输入                                                                                     |
| A7  | zod-to-openapi + OpenAPI 快照进契约测试          | 待发                                                                                                                                 |

**逐组节奏**：Codex 每完成一组即提交可复现评审证据，不攒批。某组内争议不阻塞下一组——除非改变下游形状。

**放行语义（2026-07-20 manpengan 裁定，ADR-10 后由 Codex 维护）**：tag `contracts@v0.1.0` 是最终封版标记，不是放行闸。每组评审通过并合入即冻结、下游可依赖；七组全绿且 ADR-09 已签署后向 manpengan 提交 tag 建议。

理由：下游各自只依赖其中若干组，把 tag 当闸会让他们空转到 A7 的 OpenAPI 快照做完为止。对应关系：

| 组冻结           | 解闸的下游                                   |
| ---------------- | -------------------------------------------- |
| A2 信封 + 错误码 | 全队错误处理；Codex C7（另需 A6+C1）         |
| A4 Edge 桥协议   | Grok D2 配对签名 / D3 加密队列 / D4 打印回执 |
| A5 会话/CSRF     | Grok E1 登录页（另需 Codex C6）              |
| A6 首批命令定义  | Codex C6/C7、Grok E3（另需 A7）              |

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
