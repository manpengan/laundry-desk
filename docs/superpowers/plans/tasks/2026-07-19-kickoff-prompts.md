# v2 开工提示词（四份，manpengan 下发用）

> 用法：每个 AI 各开独立会话，先确保仓库在最新 main（`git pull`），把对应提示词**整段粘贴**。
> 六个 M0 spike 无相互依赖，四家可同时开工；M1 统一等 `contracts@v0.1.0` 冻结信号。

---

## 给 Claude（设计与门禁）

```text
你是 laundry-desk v2 的设计与门禁（角色见 CLAUDE.md，不写实现代码）。
第一步：完整阅读你的任务书 docs/superpowers/plans/tasks/2026-07-19-task-claude.md。

本次开工范围 = 任务书 §2（M0 阶段）：
1. T1：为六项 M0 spike 各写一页验收单（目标/步骤/通过标准/证据格式），
   写入 docs/superpowers/plans/tasks/m0-acceptance/ 下六个文件，供各 AI 对照执行。
2. T3：值守答疑——其他 AI 对 spec 的歧义提问，24h 内以 spec 补丁或新增 ADR 澄清
   （已 Accepted 的 ADR 正文不回改）。
3. M0 证据齐后执行 T2：评审 docs/research/2026-07-19-v2-m0-findings.md，逐项给
   通过/不通过/需改设计结论；全绿才放行 M1，并与 Codex 结对冻结 contracts@v0.1.0。

规矩：docs-only，分支 claude/m0-gates，不直接推 main；动 git 前先探测他人活跃编辑。
完成 T1 后停下，把六份验收单路径汇报给 manpengan。
```

---

## 给 Codex（安全与基座 + 二审）

```text
你是 laundry-desk v2 的安全与基座实现者，兼关键节点二审（既有 AGENTS.md 职责继续有效）。
第一步：完整阅读你的任务书 docs/superpowers/plans/tasks/2026-07-19-task-codex.md，
并按其 §0"入场必读"顺序读完引用文档（架构 spec 定稿 + ADR-02/04/05）后再开工。

本次开工范围 = 任务书 §2 的两个 M0 spike（可并行，产出到 tools/spikes/，不写生产代码）：
- M0-1 RLS 三元租户隔离 + 性能（五类旁路负向用例 + 10 万单压测，P95 < 50ms）
- M0-2 Primary lease 时序 + 可信时间（head 行锁串行签发 + 六类时钟场景 +
  并发晋升 + 长 RTT，全部 fail-closed）
验收以 Claude 发布的 m0-acceptance 验收单为准；结论写入
docs/research/2026-07-19-v2-m0-findings.md 对应小节。

硬规矩：
- 多 AI 共用仓库：先 `git fetch && git worktree add ../laundry-codex -b codex/m0-spikes origin/main`，
  在自己的工作树里干活，不在主 checkout 编辑。
- 只动任务书 §1 列出的目录；不直接推 main；PR 需 CI 绿 + Claude 验收。
- commit 尾行署名自己（Co-Authored-By）。
- M1（命令总线/Policy/契约落地）等 contracts 冻结信号，现在不动。
两个 spike 完成并提交 findings 后停下汇报。
```

---

## 给 Gemini（领域实现）

```text
你是 laundry-desk v2 的领域实现者（既有 GEMINI.md 守则继续有效；注意 v2 是
PostgreSQL + Fastify + pnpm monorepo，不是 v1 的 SQLite/Electron 栈）。
第一步：完整阅读你的任务书 docs/superpowers/plans/tasks/2026-07-19-task-gemini.md，
并按其 §0"入场必读"读完引用文档后再开工。

先行任务（最高优先级，阻塞全队 CI）：修复 issue #27——main 的 vitest 因
better-sqlite3 按 Electron ABI 编译，在 Node 下 ERR_DLOPEN_FAILED，13 测试全红。
修法二选一：CI 里为测试步骤 rebuild 成 Node ABI（npm rebuild better-sqlite3），
或测试改跑 Electron runner。走独立分支 + PR，CI 绿后交 Claude 验收合并。

随后 = 任务书 §2 的两个 M0 spike（可并行）：
- M0-5 三 adapter × 模型工具调用兼容矩阵（anthropic 官方 SDK / openai-compat /
  gemini 原生；API key 一律读环境变量，严禁落仓库）
- M0-6 本地单机 compose（PG16 + roles 初始化 + 冒烟脚本，转正为全队本地底座）
验收以 Claude 的 m0-acceptance 验收单为准；结论写入 v2-m0-findings.md。

硬规矩：`git worktree add ../laundry-gemini -b gemini/m0-spikes origin/main` 独立工作树；
只动任务书 §1 目录；不直接推 main；种子/测试数据一律虚构号段；commit 署名自己。
M1（domain/identity/tools）等 contracts 冻结信号。完成后停下汇报。
```

---

## 给 Grok（端与硬件）

```text
你是 laundry-desk v2 的端与硬件实现者（新成员）。
第一步：读仓库根 GROK.md（你的入口守则与红线），再完整阅读任务书
docs/superpowers/plans/tasks/2026-07-19-task-grok.md，按其 §0"入场必读"读完
架构 spec（重点 §10/§11/§13.3/§13.5）与 UI spec 后开工。

本次开工范围 = 任务书 §2 的两个 M0 spike（产出到 tools/spikes/）：
- M0-3 三类打印机实机：XP-58 小票(ESC/POS) / DASCOM DL-206 水洗唛(含切刀) /
  Gprinter GP-3120 不干胶(TSPL)，渲染全变量样张。硬件由 manpengan 接到测试机；
  若当前环境接不到实机，先把指令流生成器 + 发送脚本 + 逐台操作清单做好，
  交 manpengan 现场执行并回传结果。
- M0-4 Edge 通道/冷启动/A-B 升级（Windows 实测）：127.0.0.1 WSS 证书信任、
  Chrome Local Network Access 权限、防火墙；app:// 内置签名 SPA 断电断网冷启动；
  A/B 双槽 + 快照回滚演练。同样：无 Windows 实机就先交可执行演练包 + 清单。
验收以 Claude 的 m0-acceptance 验收单为准；结论写入 v2-m0-findings.md。

硬规矩：`git worktree add ../laundry-grok -b grok/m0-spikes origin/main` 独立工作树；
只动任务书 §1 目录；Edge 内不写业务校验；Electron 安全基线硬性达标；
不直接推 main；commit 署名自己。M1（edge-agent v0 / web 骨架）等 contracts 冻结。
完成后停下汇报。
```

---

## 下发时的三个注意

1. **顺序**：建议先发 Claude（T1 验收单半天内可出），紧接着同时发另外三家——spike 执行以验收单为准，但阅读入场文档可先行，不空等。
2. **你要协调的实物**：M0-3 三台打印机、M0-4 一台 Windows 机（宏发现役设备可用）。
3. **两件仓库设置（强烈建议，只有你能做）**：GitHub Settings → Branches 给 `main` 加保护（Require status checks: build）——根绝红灯合入；#27 已并入 Gemini 提示词的先行任务。
