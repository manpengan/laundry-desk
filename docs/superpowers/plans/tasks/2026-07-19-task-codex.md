# laundry-v2 开发任务书 · Codex（安全与基座）

> 下发：manpengan　起草：Claude（设计与门禁）　日期：2026-07-19
> 覆盖：V2-M0（两项 spike）+ V2-M1（命令总线基座）+ 二审职责
> 完成定义：逐项对照"验收标准"；PR 过 §5 门禁自查 + Claude 验收。

## 0. 入场必读（按序）

1. `docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`（定稿真源，重点 §4/§6.5/§7/§8/§9/§10）
2. `docs/adr/2026-07-19-adr-02-postgres-multitenancy-rls.md`、`adr-04`（lease）、`adr-05`（命令/策略/审批）
3. `docs/superpowers/plans/2026-07-19-v2-m0-m1-implementation-plan.md`
4. `~/.claude/rules/common/coding-style.md` 红线：文件 ≤400 行、函数 ≤50 行、嵌套 ≤4、金额整数分、不可变优先
5. `AGENTS.md`（你的既有二审职责，继续有效）

## 1. 目录所有权与边界

- **你拥有**：`apps/server` 的基座部分（命令总线/Policy/审计/Tool Registry）、`packages/contracts` 的 Zod 落地、`tools/spikes/m0-1-rls`、`tools/spikes/m0-2-lease`
- **禁止**：改 `apps/web`、`apps/edge-agent`、`packages/domain` 的他人文件；绕过命令总线直调 service；动 git 前先探测他人活跃编辑（三 AI 共 checkout 教训）；不直接推 main

## 2. M0 任务（spike，产出到 `tools/spikes/`，不写生产代码）

### M0-1 RLS 三元租户隔离 + 性能（`tools/spikes/m0-1-rls/`）

- 建最小三表 orders/order_lines/garments：三元组合键 `UNIQUE(org_id, store_id, id)` + 组合外键（garments→order_lines 含 order_id）；`ENABLE + FORCE ROW LEVEL SECURITY`；非 owner 角色 `laundry_app`（NOBYPASSRLS）；策略模板 USING + WITH CHECK 各一（org 级/店级）
- 五类旁路负向用例：GUC 未设置 / GUC 空值 / 事务回滚后残留 / 连接池复用串租户 / worker 漏注入
- 灌 10 万订单造压，测带 `(org_id, store_id, …)` 复合索引的常用查询
- **验收**：五类旁路全部 0 行（未设 GUC 必须查不到而非报错放行）；单店常用查询 P95 < 50ms；产出 README（可复现步骤）+ 数据写进 `docs/research/2026-07-19-v2-m0-findings.md` 对应小节

### M0-2 Primary lease 时序 + 可信时间（`tools/spikes/m0-2-lease/`）

- 实现：`primary_lease_heads(org_id, store_id)` 行 `SELECT ... FOR UPDATE` 串行签发（同一事务：重校验旧 lease → epoch++ → 插入 `UNIQUE(org_id, store_id, primary_epoch)` → 更新 head → 提交后返回签名 lease）；签名对象含 `lease_id/issued_at/ttl_ms/max_clock_skew_ms/not_after`
- Edge 侧模拟：`local_deadline = request_start_mono + ttl_ms − safety_margin_ms`（锚点=发起请求前；禁 `Date.now()` 判有效性）
- 演练脚本覆盖：六类时钟场景（回拨/前跳/进程重启/OS 重启/休眠跨期/旧主失联）+ 双 owner 并发晋升 + 释放与晋升并发 + 长 RTT（RTT ≥ TTL）
- **验收**：时钟回拨旧主的命令被 epoch 拒收进仲裁；并发晋升不产生两个有效 lease；无 ACK 时新 lease 必等旧到期+容差；RTT≥TTL fail-closed；时间连续性不可证时 lease 立即失效

## 3. M1 任务（生产代码）

### A 包 · `packages/contracts` Zod 落地（Claude 定语义并评审，你实现）

- [ ] A1 命令/查询注册表 schema：`{name, version, input:Zod, risk:R0–R5, invariants, idempotent, sideEffects, offline_allowed, data_classification, max_batch, result_redaction}`
- [ ] A2 统一信封 `{ok,data}|{ok,error}` + 错误码表
- [ ] A3 租户表矩阵 + 三元组合键约定 + RLS USING/WITH CHECK 模板（SQL 常量）
- [ ] A4 Edge 桥协议类型（能力票据/执行回执/offline grant/Primary lease/队列信封版本）
- [ ] A5 会话/CSRF 契约　[ ] A6 M1 首批命令定义（identity/platform 域）　[ ] A7 zod-to-openapi 生成
- **验收**：Claude 评审通过打 tag `contracts@v0.1.0`；OpenAPI 快照进契约测试

### C 包 · `apps/server` 基座

- [ ] C1 命令总线运行时：注册表加载 → 校验链（Zod→RBAC→租户→Policy→不变量→事务执行【业务+审计同一事务，审计失败整体回滚】→领域事件）；幂等键；dry-run
- [ ] C2 RLS 接入：连接池**事务级** `SET LOCAL app.org_id/store_id/staff_id`（含队列 worker 同一注入）；`laundry_app` 连接；迁移走 owner 角色
- [ ] C3 审计统一落点：总线末端装饰器；`audit_log` 对应用角色仅 INSERT；审计表启用 RLS
- [ ] C4 AI Tool Registry：命令注册表只读投影（LLM 描述 + 脱敏规则 + per-preset 白名单）；R5 不投影
- [ ] C5 Policy Engine v0：R0–R5 判定 + 参数阈值升级（R3→R4）；确认卡 `ai_pending_actions`（canonical args 服务端冻结、args_hash、实体版本、nonce、5 分钟有效期、幂等键、确认只提交 nonce）；R4 同步 step-up（具备审批权限者现场 PIN/扫码、**不可自核**、原子单次消费）
- **验收**：架构测试（依赖规则 lint）证明 apps 层无法绕过总线直调 service；确认卡 WYSIWYS 断言（换参作废/过期不可执行/canonical 冻结）绿；Claude 提供的 AI 红队用例集全绿

## 4. 依赖与交接

- 你依赖：Claude 的 contracts 语义评审（结对，开工首日起）；Gemini 的 `packages/domain` 校验链纯函数骨架（B2）
- 依赖你：Gemini 的 identity/platform 服务（C6–C7）等 C1 总线就绪；Grok 的 web 登录闭环等 C6

## 5. 提交 PR 前门禁自查

TS strict 零错；ESLint+Prettier 零警告；文件/函数/嵌套红线；金额零浮点；覆盖率 ≥70%；契约测试绿；**跨租户负向测试绿**；**红队用例绿**；带种子数据；commit 尾行 `Co-Authored-By` 署名自己。

## 6. 二审职责（并行于开发）

以下 PR 必须你二审后才可合：Gemini 的 C6 鉴权中间件与 C8；Grok 的 D2 配对/票据/回执签名与 D3 队列加密（DEK/KEK）；任何触碰 RLS 策略、审计权限、Policy Engine、lease 的变更。
