# laundry-v2 开发任务书 · Gemini（领域实现）

> **Superseded for unfinished work by ADR-10**。Gemini 已退出实现关键路径；已合入资产继续维护，未合并分支只作 Codex 候选输入。

> 下发：manpengan　起草：Claude（设计与门禁）　日期：2026-07-19
> 覆盖：V2-M0（两项 spike）+ V2-M1（domain / identity / platform / tools）
> 完成定义：逐项对照"验收标准"；PR 过 §5 门禁自查 + Claude 验收（鉴权相关加 Codex 二审）。

## 0. 入场必读（按序）

1. `docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`（定稿真源，重点 §3/§5/§6/§7/§8/§9.2–9.3）
2. `docs/adr/2026-07-19-adr-03-garment-order-accounting-model.md`、`adr-05`、`adr-07`（迁移）
3. `docs/superpowers/plans/2026-07-19-v2-m0-m1-implementation-plan.md`
4. `~/.claude/rules/common/coding-style.md` 红线；`GEMINI.md`（你的既有实现守则，继续有效）
5. 注意：v2 是 **PostgreSQL + Fastify + pnpm monorepo**，不是 v1 的 SQLite/Electron 栈；v1 代码只作参考不复用直搬

## 1. 目录所有权与边界

- **你拥有**：`packages/domain`、`apps/server` 的业务服务（M1 为 identity/platform；M2 起 order/catalog/payment/membership）、`tools/`（migrate-v1 / 种子 / compose）、`tools/spikes/m0-5-adapters`、`tools/spikes/m0-6-compose`
- **禁止**：改命令总线/Policy/审计核心（Codex 目录）；改 `apps/edge-agent`、`apps/web`（Grok 目录）；service 里手写 SQL 绕过 Drizzle + RLS 约定；动 git 前先探测他人活跃编辑；不直接推 main

## 2. M0 任务（spike）

### M0-5 三 adapter × 模型工具调用兼容矩阵（`tools/spikes/m0-5-adapters/`）

- 实现最小统一内部消息格式（text/tool_use/tool_result/image 块）+ 三个 adapter：`anthropic`（官方 TS SDK，Messages API）、`openai-compat`（自定 base_url，覆盖 DeepSeek/Qwen/GLM/Kimi/豆包/Grok 任选 2 家实测）、`gemini`（原生 API）
- 每 adapter 跑同一个 tool-use 循环用例：查询工具 → 并行两工具 → 流式输出 → JSON 严格解析（禁字符串匹配）
- **验收**：每 adapter 至少一款模型稳定完成闭环；方言差异（工具格式/流式事件/结束条件）记录成表进 `docs/research/2026-07-19-v2-m0-findings.md`；API key 从环境变量读，**不落仓库**

### M0-6 本地单机模式（`tools/spikes/m0-6-compose/` → 转正为 `tools/compose/`）

- `docker compose`：PostgreSQL 16 + server 占位（healthcheck）+ 初始化 SQL（roles：owner / `laundry_app` NOBYPASSRLS）
- **验收**：`compose up` 一键起、冒烟脚本绿；此环境即全队后续本地开发底座（桌面为主策略下，壳与浏览器都连 localhost）

## 3. M1 任务（生产代码）

> **2026-07-20 分工调整**：manpengan 决定按各家实测表现重新配比——安全敏感与高复杂度任务集中给 Codex，你这边**任务量减少、难度降低**，聚焦规则明确、可被测试完全覆盖的工作。原属你的 C6/C8（identity 与鉴权中间件）、F1（迁移器）已移交 Codex。

### B 包 · `packages/domain`（纯函数，TDD，**覆盖率 100%**）

规则在 spec 里写死，无需设计决策；每条都能用穷举单测证明对错——这是本包的价值。

- [ ] B1 金额工具：整数分、格式化、分摊/取整规则；任何浮点出现即测试失败
- [ ] B3 order/garment 状态机显式转移表（含 delivered/reworked/lost；fulfillment 关闭坍缩为 received→picked_up|delivered）+ 穷举单测（非法转移全被拒）

> B2（命令校验链骨架）已由 Codex 在 contracts 内定义接口并 stub（见放行记录 D2），你不再负责。
> B4（风险分级判定 R0–R5）随 Policy Engine 一并移交 Codex——它与确认卡、step-up 强耦合。

### C 包 · `apps/server` 业务服务（等 Codex C1 总线就绪后接入）

- [ ] C7 platform：settings、`store_features` flags、审计查询（只读）

> C6 identity 与 C8 鉴权中间件移交 Codex：涉及 argon2id 参数、JWT/refresh 轮换、CSRF、
> 以及"拒绝客户端/LLM/Edge 自报租户"这一跨租户安全边界，与他的 RLS/Policy 工作同源。

### F 包 · `tools/`

- [ ] F2 种子数据：1 org / 1 store / 管理员+店员 / 价目字典（参考顺科 11 服务 × 品类）
- [ ] F3 compose 转正（承接 M0-6，门禁通过后执行）

> F1 迁移器移交 Codex：件级拆分 + 条码补发是 v1→v2 最大不可逆点，出错会污染宏发真实数据。

## 4. 依赖与交接

- 你依赖：`contracts@v0.1.0`（B 包只依赖类型，可最早开工）；Codex C1 总线（C7 接入点）
- 依赖你：全队用你的 F2 种子与 F3 compose

## 5. 给你的三条工作建议（基于 M0 复盘）

1. **证据即结论**：findings 里的结论行不得超出证据强度。无真实 key 时写「待实测」而非「通过」——M0-5 首轮判负正因于此。
2. **先 rebase 再提交**：M0 期间在过时工作树上提交，覆盖了 main 已有的 CI 修复（build/ 资产、workflow、e2e 断言三处回退）。每次开工前 `git fetch && git rebase origin/main`。
3. **断言必须能失败**：`|| echo "PASS"` 对任何非零退出都通过，等于永不失败（M0-6 Test 4 判负原因）。写完测试先人为破坏一次，确认它真会红。

## 5. 提交 PR 前门禁自查

TS strict 零错；ESLint+Prettier 零警告；文件 ≤400 行/函数 ≤50 行/嵌套 ≤4；金额零浮点；`packages/domain` 覆盖率 **100%**、其余 ≥70%；契约测试绿；每 PR 带种子数据可复现；不引入 v1 的 better-sqlite3 依赖；commit 尾行署名自己。
