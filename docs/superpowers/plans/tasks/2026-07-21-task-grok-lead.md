# laundry-v2 当前任务书 · Grok（单一技术负责人）

> 下发：manpengan　日期：2026-07-21  
> 决策依据：[ADR-12](../../../adr/2026-07-21-adr-12-grok-unified-delivery-ownership.md)  
> 详设：[交付治理](../../specs/2026-07-21-laundry-v2-delivery-governance.md)  
> 覆盖：M1 未完成项及 M2—M6 后续设计、核心实现、集成与门禁。  
> **取代**：[task-codex-lead](2026-07-21-task-codex-lead.md)、[task-grok-assist](2026-07-21-task-grok-assist.md)

## 0. 入场顺序

1. `GROK.md` / `AGENTS.md`  
2. 治理 spec + ADR-12  
3. 架构 spec + ADR-02/04/05/09/11  
4. `2026-07-21-v2-m1-takeover-implementation-plan.md`（执行者读作 Grok）  
5. `m1-acceptance/README.md`  

## 1. 当前完成状态（签收 main）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| A1/A2/A3/A4/A5 | 已合入 | contract-only 部分 runtime 仍缺；无最终 tag |
| B1/B3/E2 | 已合入 | 继续复用 |
| D1/D5/web 壳 | 骨架 | 不可标生产完成 |
| F2/F3 | seed + mock compose | 待正式 PG/server |
| A6/A7/B2/B4 | 未实现 | **当前第一批** |
| C1—C8/F1 | 未实现 | 等契约/PG 前置 |
| D2/D3/E1/E3 | 未实现 | 现可同一 owner 内串行推进 |

## 2. 交付顺序

### P0 治理

- [x] ADR-12 与入口/任务书（本变更）  
- [ ] manpengan 签署 ADR-09  
- [ ] 未合远端 AI 分支只读归档，不继续并行写 main  

### P1 contracts / domain

- [ ] **A6** identity/platform 首批命令  
- [ ] **A7** OpenAPI 3.1 + 快照  
- [ ] **B2** 校验链 ports  
- [ ] **B4** 风险阈值纯函数  
- [ ] A1–A7 全绿 + ADR-09 签署后 `contracts@v0.1.0`  

### P2 PG / server

- [ ] `packages/db` + migrations（与 v1 SQLite 隔离）  
- [ ] C2 事务/GUC/roles + 五类旁路  
- [ ] C1 Command Bus + C3 同事务审计  
- [ ] C6 identity + C8 注入  
- [ ] C5 Policy / 确认卡 / step-up  
- [ ] C4 Tool Registry + C7 platform  

### P3 Edge / Web

- [ ] Edge core + D2/D3/D4  
- [ ] D1/D5 证据与 I/O  
- [ ] E1/E3  

### P4 集成

- [ ] 真实 compose、seed CI、F1 试跑、全门禁  

## 3. 红线（不可省）

canonical/签名、DEK/KEK、RLS、审计权限、lease/grant、确认卡不可自核、金额整数分、证据 ≥ 结论。

## 4. 合并

required checks 绿 → 可合并 → 复核 main 双 workflow。  
