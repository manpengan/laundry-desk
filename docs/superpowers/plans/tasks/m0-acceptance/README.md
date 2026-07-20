# M0 验收单索引与公共规则

> 起草：Claude（设计与门禁）　日期：2026-07-19
> 用途：六项 M0 spike 各一页验收单，主责 AI 随任务对照执行；证据齐后 Claude 按单逐条判定（任务书 T2）。

## 索引

| # | 验收单 | 主责 | 产出目录 |
|---|---|---|---|
| M0-1 | [RLS 三元租户隔离 + 性能](m0-1-rls.md) | Codex | `tools/spikes/m0-1-rls/` |
| M0-2 | [Primary lease 时序 + 可信时间](m0-2-lease.md) | Codex | `tools/spikes/m0-2-lease/` |
| M0-3 | [三类打印机实机](m0-3-printers.md) | Grok | `tools/spikes/m0-3-printers/` |
| M0-4 | [Edge 本地通道 + 冷启动 + A/B 升级](m0-4-edge.md) | Grok | `tools/spikes/m0-4-edge/` |
| M0-5 | [三 adapter × 模型工具调用兼容矩阵](m0-5-adapters.md) | Gemini | `tools/spikes/m0-5-adapters/` |
| M0-6 | [本地单机模式（compose）](m0-6-compose.md) | Gemini | `tools/spikes/m0-6-compose/` |

## 公共规则（适用全部六项）

1. **spike 性质**：只产出验证代码与证据，**不写生产代码**、不并入生产依赖；目录限定在 `tools/spikes/m0-X-*/` 内。
2. **隐私红线（仓库 PUBLIC）**：一切样本数据虚构（手机号一律虚构号段如 `13800000xxx`）；照片/截图先**去 EXIF**（RFC 素材裁决）；API key、凭据只走环境变量，**不落仓库、不进日志、不进 findings**。
3. **证据落点**：原始证据放各 spike 目录 `evidence/` 子目录；结论与关键数据写入 [`docs/research/2026-07-19-v2-m0-findings.md`](../../../../research/2026-07-19-v2-m0-findings.md) 对应小节（骨架已建，按小节模板填写，勿改他人小节）。
4. **可复现**：每 spike 根目录 `README.md` 必须让另一名 AI 不看对话记录即可复跑（环境、依赖、一键脚本、预期输出）。
5. **判定**：Claude 对照本目录验收单逐条给 **通过 / 不通过 / 需改设计**；「需改设计」→ Claude 起草新增 ADR（不回改已 Accepted 正文），评审后才进 M1。
6. **git 纪律**：各自分支（`codex/m0-spikes`、`gemini/m0-spikes`、`grok/m0-spikes`）；动 git 前先探测他人活跃编辑；不直接推 main。
7. **答疑（T3）**：spec/验收单有歧义，在团队频道 @Claude 或开 issue；24h 内以 spec 补丁或新增 ADR 书面澄清，口头澄清不算数。
