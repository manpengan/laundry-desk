# ADR-13: 停止 v1 功能线，统一交付 v2 升级版本

- 日期：2026-07-23
- 状态：**Accepted**（manpengan 会话裁决：「宏发单店版后续不再进行，直接做升级版本」）
- 详设：[V2-only 升级实施计划](../../.hermes/plans/2026-07-23_034229-v2-only-upgrade-next-development-plan.md)
- 覆盖：ADR-07 第 5 点、ADR-07 第 4 点中的“切换窗口双写观察”方式、总 RFC「v1 spec 继续约束宏发 M1–M4 收口」以及旧 v1 M4/M5/GA 路线；保留 ADR-07 的迁移字段映射与数据核对要求

## 决策

1. **laundry-desk 仅保留一条活动交付线：v2 产品化升级。** 后续设计、实现、测试、CI、实机与发版资源全部投入 `apps/`、`packages/` 和 v2 `tools/`。
2. **宏发 v1 单店版停止后续功能开发与独立发版。** 不再实施 v1 M4（登录/权限/SMS）、v1 M5（独立 UI 2.0）或旧 `v0.1.0`–`v1.0.0` 收口/tag 路线。
3. 根目录 `src/`、v1 SQLite schema 与历史测试暂时冻结保留，只允许用于：
   - `tools/migrate-v1` 的只读提取与兼容验证；
   - 对照既有业务行为；
   - v2 切换后的限期只读回退。
4. v1 冻结代码不得接收新业务功能；只有直接阻塞迁移、数据可读性或安全取证的问题才可在独立 PR 中最小修复，并必须证明不改变业务数据语义。
5. 下一客户交付目标是 **V2-M2 宏发升级候选版**：真实 PostgreSQL/RLS、柜台完整工作日、Local Edge 离线闭环、三类打印、v1 数据迁移与只读 AI/BYOK 最小闭环。
6. v1→v2 迁移仍是强制门禁：源 SQLite 只读、`order_items → order_lines + garments`、补条码、金额/件数/客户数 reconciliation 为零差异。切换采用“冻结 v1 写入 → 最终备份 → 一次性迁移 → v2 单写 → v1 限期只读回退”，不采用 v1/v2 双写观察。
7. v1 既有 Build/Release 结果只作为历史/迁移兼容证据，不再代表客户 release。v2 integration 与 v2 Windows release workflow 接管正式门禁后，再另行移除旧 workflow。
8. `src/` 的最终删除不在本 ADR 范围内；V2-M2 稳定期结束后通过新 ADR 决定归档或移除。
9. ADR-12 的 owner 与门禁不变：Grok 仍是单一技术负责人，manpengan 保留产品裁决、外部环境与最终仲裁。

## 理由

- 同时收口 v1 与建设 v2 会重复实现身份、审计、UI、打印与通知，持续分散关键路径。
- 当前 main 已有 contracts v0.1.0、PG/RLS、Command Bus、Identity/Policy、Web/Edge 骨架和 M2 柜台增量，直接补齐 v2 闭环比继续投资单机 SQLite 路线更符合产品化目标。
- 宏发仍需要现有数据和业务连续性，因此冻结 v1、优先做可核对迁移，比立即删除 v1 更安全。
- Accepted ADR 不回改正文；用新 ADR 明确覆盖关系，可保留历史决策与审计链。

## 否决的备选

- **先完成 v1 M4/M5 再做 v2**：重复投资且延迟升级版本，否决。
- **继续 v1/v2 双线并行**：资源分散、状态文档持续失真，否决。
- **立即删除 `src/` 与 v1 tests**：失去迁移源、行为基线与只读回退，否决。
- **直接回改 ADR-07/总 RFC 正文**：破坏已签署决策记录，否决。

## 后果

- README、CHANGELOG、Agent 入口、架构 spec 与当前任务书统一改为 V2-only；v1 spec 只增加 archived/superseded 状态，不改历史正文。
- v1 GitHub issues/milestones 保留历史评论后关闭为 Superseded/Archived；新工作只进入 V2-M2 milestone。
- 腾讯云 SMS 随 v2 M3 notification adapter 实现，不再落到 v1。
- Liquid Glass 可复用资产继续进入 `packages/ui`，不再作为 v1 M5 独立发版。
- `tools/migrate-v1`、真实 PG integration、Edge 离线与 Windows 三打印机成为升级候选版关键路径。
- 客户可见 SemVer 在 V2-M2 门禁报告签署时确定；不复用未发布的旧 v1 `v0.x` tag。
