# laundry-v2 当前任务书 · Grok（单一技术负责人）

> 下发：manpengan　初版：2026-07-21　路线更新：2026-07-23
> Owner：[ADR-12](../../../adr/2026-07-21-adr-12-grok-unified-delivery-ownership.md)
> 产品路线：[ADR-13](../../../adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)
> 详设：[交付治理](../../specs/2026-07-21-laundry-v2-delivery-governance.md) · [V2-only 执行计划](../../../../.hermes/plans/2026-07-23_034229-v2-only-upgrade-next-development-plan.md)
> 覆盖：唯一活动线 v2 的后续设计、核心实现、集成与门禁；v1 仅保留迁移与历史参考。

## 0. 入场顺序

1. `GROK.md` / `AGENTS.md`
2. ADR-13 + ADR-12 + 交付治理
3. v2 架构 spec + ADR-02/04/05/09/11
4. V2-only 执行计划
5. V2-M2→M6 实施计划

## 1. 当前完成状态（main@8c152d5）

| 项                | 状态       | 说明                                                                                  |
| ----------------- | ---------- | ------------------------------------------------------------------------------------- |
| A1–A7             | 已冻结     | ADR-09 Accepted；`contracts@v0.1.0` 已封版                                            |
| Domain/Bus/Policy | 已合入基座 | B2/B4、Command/Query Bus、审计、WYSIWYS/step-up 已有代码与测试                        |
| PG/Identity       | 已合入基座 | 正式 PG schema、RLS/GUC、Identity/CSRF/PIN 已有；真实 PG CI 仍需收口                  |
| Edge/Web          | 增量骨架   | Electron 安全壳、配对/队列/打印/升级骨架及柜台 SPA 已有；生产 I/O/离线闭环未完成      |
| V2-M2 柜台        | 进行中     | 开单/部分取衣、payments、catalog、打印队列、顾客、订单/欠款、统计/交班、照片已进 main |
| 迁移/集成/AI      | 未收口     | `tools/migrate-v1`、真实 compose/CI、BYOK/只读 AI、三机实测仍是关键缺口               |

## 2. 当前交付顺序

### P0：V2-only 治理与可信基线

- [ ] ADR-13 与 README/CHANGELOG/Agent 入口落档
- [ ] 从最新 main 重做 `fix-review-blockers`，保护 #99，索引 migration 使用 `0014`
- [ ] 真实 server+PG compose 与无 skip 集成 CI

### P1：M2 contracts/domain/server

- [ ] contracts v0.2：catalog/order/payment/customer/print/stats/shift/photo + OpenAPI
- [ ] 五段计价、付款 ledger、hold/cancel、部分取衣、营业日纯函数
- [ ] M2 全生产路径走 PG/RLS/事务审计，禁止关键 memory fallback

### P2：升级关键路径

- [ ] `tools/migrate-v1` 只读迁移 + 零差异 reconciliation
- [ ] Edge OS secret/SQLCipher/offline grant/Primary lease/replay
- [ ] XP-58 / DL-206 / GP-3120 签名打印与真实 Windows 证据
- [ ] Web 完整工作日 real-PG Playwright
- [ ] BYOK 最小闭环 + R0–R2 只读 AI

### P3：V2-M2 升级候选版

- [ ] Windows 包、断网冷启动、A/B 升级与回退
- [ ] 宏发 v1 只读副本迁移演练
- [ ] 一整天营业、断网恢复、三打印机、迁移与 AI 红队全门禁
- [ ] 同一 SHA 的 foundation / v2 integration / Windows release 全绿

## 3. v1 冻结边界

- 不继续 v1 M4/M5/GA，不补旧 v1 tag。
- 不向根 `src/` 增加功能；只有直接阻塞迁移、数据可读性或安全取证时允许最小修复。
- 腾讯云 SMS 进入 v2 M3 notification adapter；Liquid Glass 资产只在 `packages/ui` 演进。

## 4. 红线（不可省）

canonical/签名、DEK/KEK、RLS、审计权限、lease/grant、确认卡不可自核、金额整数分、证据 ≥ 结论、断言必须能失败、双锁同步。

## 5. 合并

每项独立短分支/PR；required checks 与门禁绿后可合并，随后复核 main 同 SHA 的全部必需 workflow。
