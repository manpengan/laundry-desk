# M1 门禁资产索引（contracts 冻结 + 逐包验收）

> 起草：Claude（设计与门禁）　日期：2026-07-20
> 用途：T4 contracts@v0.1.0 逐组冻结评审 + T5 门禁资产 + T6 逐 PR 验收的统一入口。

## A1–A7 契约冻结评审单（T4，与 Codex 结对，逐组过）

| 组 | 评审单 | 状态 |
|---|---|---|
| A1 | [命令/查询注册表 schema](a1-command-registry.md) | **设计稿已评审（[回执](2026-07-20-a1-review-response.md)）——两处按裁决改后落地** |
| A2 | 统一信封 + 错误码表 | 待 A1 通过后发 |
| A3 | 租户表矩阵 + 三元组合键 + RLS 模板 | 待发（**直接采信 M0-1 实测底稿，不重新设计**） |
| A4 | Edge 桥协议类型 | 待发（**直接采信 M0-2 签名 lease 对象结构**） |
| A5 | 会话/CSRF 契约 | 待发 |
| A6 | M1 首批命令定义（identity/platform） | 待发 |
| A7 | zod-to-openapi + OpenAPI 快照进契约测试 | 待发 |

**逐组节奏**：Codex 每完成一组即提交评审，不攒批。某组内的争议不阻塞下一组开工——除非该争议改变下游组的形状（如 A1 的字段形状决定 A6 的标注方式）。

**放行语义（2026-07-20 manpengan 裁定，修订原"七组全绿才放行"）**：tag `contracts@v0.1.0` 是**最终封版标记，不是放行闸**。**每组评审通过即宣告该组冻结、下游立即可依赖**——该组 PR 合入时 Claude 在上表标注「已冻结」并通知等待方，无须等七组齐。七组全绿后打 tag 封版；**此后改契约一律走新增 ADR**。

理由：下游各自只依赖其中若干组，把 tag 当闸会让他们空转到 A7 的 OpenAPI 快照做完为止。对应关系：

| 组冻结 | 解闸的下游 |
|---|---|
| A2 信封 + 错误码 | 全队错误处理；Gemini C7（另需 A6） |
| A4 Edge 桥协议 | Grok D2 配对签名 / D3 加密队列 / D4 打印回执 |
| A5 会话/CSRF | Grok E1 登录页（另需 Codex C6） |
| A6 首批命令定义 | Gemini C7、Grok E3 权限门控路由 |

**注**：Grok 的 **D1 Electron 壳**与 **D5 A/B 双槽**、Gemini 的 **F2 种子数据**经复核**不依赖任何契约组**，已于 2026-07-20 单独解闸（见 [解闸提示词](2026-07-20-unblock-prompts.md)）——开工提示词此前将其误列在闸后。

## T5 门禁资产（我出规格、对应 AI 执行、我验收）

| 资产 | 规格 | 执行方 | 状态 |
|---|---|---|---|
| 每包 PR 验收 checklist 模板 | [pr-checklist-template.md](pr-checklist-template.md) | 全员自查 | **已出** |
| 跨租户五类旁路负向用例 → CI 门禁 | [t5-cross-tenant-ci-gate.md](t5-cross-tenant-ci-gate.md) | Codex（随 C2 交付） | **已出** |
| AI 红队用例集 ≥20 条 | 待出——**依赖 A1 的 Tool Registry 投影形状**，A1 通过后即出 | Codex（C4/C5 消费） | 待发 |
| 确认卡 WYSIWYS E2E 断言规格 | 待出——**依赖 A1/A2 的确认卡契约形状**，两组通过后即出 | Codex（C5） | 待发 |

## 四条本期红线（M0 实测教训，已写入 PR checklist）

1. **证据强度 ≥ 结论强度**——无实测证据不得写"通过"；没跑就写"待实测"。（M0-5 判负主因：mock 输出删掉横幅冒充实测）
2. **提交前 rebase**——`git fetch origin && git rebase origin/main`。（M0 期间有人在过时工作树提交，覆盖了 main 已有的 CI 修复）
3. **断言必须能失败**——`|| echo PASS` 式恒真断言一律打回；写完先人为破坏一次确认它会红。（M0-6 Test 4 判负原因）
4. **双锁文件同步**——增删依赖必须同时更新 `package-lock.json` 与 `pnpm-lock.yaml`，否则两条 CI 线必红一条；装依赖前先查 peer 兼容性。（#38 已踩）

## 争议与澄清（T3 值守，24h 内书面回应）

spec 歧义一律以**新增 ADR** 或 spec 补丁澄清，已 Accepted 的 ADR 正文不回改。本期已出：

- [ADR-09 命令元数据字段精确化](../../../../adr/2026-07-20-adr-09-command-metadata-precision.md)（Proposed，待签署；**含修订 1**）——`offline_allowed` 三值化；`max_batch` 拆 `size_measures`（怎么算）/ `hard_limits`（超即拒）/ `risk_escalation`（超即升 R4）三字段。**A1 按此落地，勿按 §6.5 字面。**修订 1 采纳自 Codex A1 设计稿指出的求值缺口。
