# laundry-v2 当前任务书 · Codex（单一技术负责人）

> **SUPERSEDED by [task-grok-lead](2026-07-21-task-grok-lead.md) / [ADR-12](../../../adr/2026-07-21-adr-12-grok-unified-delivery-ownership.md)**（2026-07-21）。下文保留为历史 Codex-lead 记录，不再作为当前任务真源。


> 下发：manpengan　日期：2026-07-21
> 决策依据：[ADR-10](../../../adr/2026-07-21-adr-10-single-owner-delivery-governance.md)
> 详设：[单一技术负责人交付治理](../../specs/2026-07-21-laundry-v2-delivery-governance.md)
> 覆盖：M1 未完成项及 M2—M6 后续设计、核心实现、集成与门禁。

## 0. 入场顺序

1. `AGENTS.md`
2. `docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md`
3. `docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`
4. ADR-02 / ADR-04 / ADR-05 / ADR-09 / ADR-10
5. `docs/superpowers/plans/2026-07-21-v2-m1-takeover-implementation-plan.md`
6. `docs/superpowers/plans/tasks/m1-acceptance/README.md`

## 1. 当前完成状态

| 项                | 状态                | 说明                               |
| ----------------- | ------------------- | ---------------------------------- |
| A1/A2/A4          | 已合入、组内冻结    | 最终 `contracts@v0.1.0` 尚未打 tag |
| B1/B3/E2          | 已合入              | 继续复用                           |
| D1/D5             | 骨架                | 不能标记生产完成                   |
| F2/F3             | seed + mock compose | 待正式 PG/server 集成              |
| A3/A5/A6/A7/B2/B4 | 未实现              | 当前第一批关键路径                 |
| C1—C6/C8/F1       | 未实现              | 等对应契约/PG 前置                 |
| C7                | main 未实现         | 旧内存分支不直接合入               |
| D2/D3/E1/E3       | 未实现              | 由 Codex 冻结接口后交 Grok 适配    |
| D4                | mock/spike          | 三台实机通过前不完成               |

## 2. 当前交付顺序

### P0 基线与治理

- [x] 复核并合入 PR #54；main 两条 workflow 已在 `9da3c5f` 同提交全绿
- [ ] 合入 ADR-10、治理 spec、当前任务书和计划
- [ ] 请求 manpengan 独立签署 ADR-09
- [ ] 更新 A4 冻结索引，不提前打 contracts tag

### P1 contracts 与 domain

- [ ] A3 租户矩阵/三元键/RLS 模板契约
- [ ] A5 session/refresh/CSRF/PIN 契约
- [ ] A6 identity/platform 首批命令
- [ ] A7 OpenAPI 3.1、快照、生成类型
- [ ] B2 校验链 ports 与纯函数
- [ ] B4 风险判定与阈值升级
- [ ] A1—A7 全绿后创建 `contracts@v0.1.0`

### P2 PG 与 server

- [ ] v2 PG schema/config/migrations，与根 v1 SQLite 完全隔离
- [ ] C2 transaction + `SET LOCAL` + app/owner/worker roles
- [ ] C1 Command Bus + C3 同事务审计
- [ ] C6 identity + C8 服务端 actor/tenant 注入
- [ ] C5 Policy/确认卡/step-up
- [ ] C4 Tool Registry
- [ ] C7 repository + bus 生产实现

### P3 Edge/Web 协助管理

- [ ] Codex 定义 Edge core ports、签名/密钥/lease/队列/打印/升级安全核心
- [ ] 将 platform/drivers/packaging adapters 交 Grok
- [ ] A5/A6/A7 冻结后交付 E1/E3；C6/C8 后跑黑盒验收
- [ ] 三打印机与 Windows 实机证据不得用 mock 替代

### P4 集成收口

- [ ] compose 接真实 server，seed 对正式 schema 可执行并进 CI
- [ ] F1 v1 SQLite 只读试跑，金额/件数/客户数零丢失
- [ ] 架构 lint、RLS 五类旁路、审计回滚、身份负向、WYSIWYS、红队、OpenAPI、Playwright 全绿
- [ ] main 同提交 CI 绿；外部实测状态单独记录

## 3. 安全不可下放项

以下由 Codex 直接设计、实现或逐行复审，不交 Grok 自由裁量：

- canonicalization 与签名范围；
- 设备密钥、DEK/KEK、SQLCipher、nonce/seq；
- actor/tenant 来源、RLS、审计权限；
- lease、回放水位、仲裁与可信时间；
- Policy 风险、确认卡、step-up、不可自核；
- 打印模板签名、job/receipt 和升级 manifest/anti-rollback 不变量。

## 4. 提交与验收

- 独立 worktree、短分支、单能力 PR；不在主 checkout 编辑。
- TDD：先写会失败的测试，确认红，再实现最小代码，最后重构。
- 增删依赖同步 `package-lock.json` 与 `pnpm-lock.yaml`。
- PR 写清真实命令、输出、基线提交和未覆盖环境。
- Codex 在 required checks 与对应验收通过后执行合并，并验证合入后 main；不得绕过门禁。
- mock、spike、远端分支、PR 绿均不能单独证明生产完成。
