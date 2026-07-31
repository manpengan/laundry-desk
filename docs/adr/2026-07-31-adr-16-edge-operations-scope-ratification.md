# ADR-16：追认边缘运营能力进入当前阶段，恢复契约面 ADR 门禁

- 日期：2026-07-31
- 状态：**Accepted**
- 决策者：manpengan
- 路线：[ADR-14：通用 V2 本地优先交付](2026-07-25-adr-14-generic-local-first-v2-delivery.md)
- 前序：[ADR-15：解冻价目写入](2026-07-28-adr-15-catalog-maintenance-unfreeze.md)
- 影响：ADR-14 §4 阶段线、`packages/contracts` v0.2 冻结面

## 背景

里程碑 1「本地单机完整柜台工作日」于 2026-07-29 达成
（[验收记录](../superpowers/specs/2026-07-29-milestone-1-local-workday-acceptance.md)）。
其后三天内合入四个批次：#121（履约与经营）、#122（本地运营与 macOS 交付加固）、
#123（边缘运营闭环）、#125（重放恢复与对账闭环）。四者各自带着门禁绿灯合入，
代码质量不是本 ADR 的争议点。

争议点是**它们越过了两条已生效的裁决，而裁决没有更新**。

### 1. 越过 ADR-14 §4 的阶段线

ADR-14 §4 把交付切成三段，并明确写下：

> 当前阶段不提前实现云同步、离线队列、Primary lease、真实打印机、AI/BYOK、
> v1 迁移或 Windows 包装。

已经合入 `main` 的实际内容：

| 能力              | 落点                                                                           | 形态                                       |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| 加密离线队列      | `apps/edge-agent/src/queue/{persistent-queue,dek-kek,safe-storage-kek,crypto}` | #123 **新建**                              |
| CUPS 真实打印     | `apps/edge-agent/src/print/{cups-worker,cups-process,mac-printer-acceptance}`  | #123 **新建**                              |
| 员工权限治理      | `apps/server/src/staff/`                                                       | #123 **新建**                              |
| Primary lease     | `apps/edge-agent/src/lease/primary-lease.ts`                                   | 2026-07-23 已存在骨架，#123 **接入并收紧** |
| 签名 A/B 更新回滚 | `apps/edge-agent/src/upgrade/`                                                 | 2026-07-20 已存在骨架，#122/#123 **激活**  |
| 正式 macOS 发布   | `apps/edge-agent/electron-builder.release.yml`                                 | #122 **新建**                              |
| 签名重放仲裁      | `apps/server/src/edge/{pg-replay,replay-service,authority-key}`                | #125 **新建**                              |
| 日结对账          | `apps/server/src/reconciliation/`                                              | #125 **新建**                              |

阶段线是一条**裁决**，不是建议。代码越过它而裁决没更新，等于阶段线已经失效但
没有人宣布失效——后来者无从判断哪些边界还算数。

### 2. 越过 ADR-15 的契约面门禁

ADR-15 在解冻 `catalog.item.upsert` 时写明：

> 这是一次有意解冻，不是冻结失效：**后续新增仍须走 ADR**。

自 ADR-15（`d5783af`）至 `734d1d0`，v0.2 冻结面实际变化：

- 命令 **15 → 29 条**（+14）：`customer.update`、`customer.merge`、
  `customer.privacy.export`、`customer.anonymize`、`photo.delete`、
  `garment.transition`、`garment.bulk_transition`、`garment.rack.assign`、
  `garment.rework`、`garment.incident.record`、`garment.mark_lost`、
  `staff.access.set`、`edge.conflict.discard`、`reconciliation.export`
- 查询 **+4 条**：`customer.get`、`customer.duplicates`、`fulfillment.workbench`、
  `staff.access.list`

最后两条命令来自 #125，合入时间在本 ADR 起草之后、合入之前——**这条漂移在本 ADR
还没落地时就又发生了一次**，因此基线数字在此一并更新为 29。

`m2-freeze.test.ts` 每次都同步更新了清单，因此门禁始终是绿的。**这正是问题所在**：
一个"冻结"测试如果随每次新增一起改写，它验证的是"清单和实现一致"，而不是"清单没有
增长"。它防不住无裁决的扩张，只防意外遗漏。

### 3. 文档与代码分叉

#121、#122、#123、#125 **四个 PR 各自都只触及 `docs/` 下 `local-web-server.md`
一个文件**，合计 400+ 文件、2 万余行代码变更。`CHANGELOG.md` 一次未更新；里程碑 1
验收记录 §5「明确未交付」至今仍把离线队列、Primary lease、macOS 自动更新、真实小票
硬件列为未交付——而它们已在 `main` 上。

任何按文档判断范围的人或 agent，都会得出与代码相反的结论。这不是一次疏漏，是连续
四次的稳定模式，因此需要一条门禁而不是一次订正（见决策 4）。

## 决策

### 1. 追认：本地边缘运营能力并入当前阶段

上表八项能力（加密离线队列、CUPS 真实打印、员工权限治理、Primary lease、签名 A/B
更新与回滚、正式 macOS 发布入口、签名重放仲裁、日结对账）**自本 ADR 起属于当前阶段
范围**，不再是 ADR-14 §4 的后置项。追认既成事实，不要求回滚。

理由：这些能力都服务于同一个目标——让本地单店在门店网络与硬件条件下真正可用。
离线队列与 lease 保证断网时柜台不停摆，重放仲裁保证恢复联网后账不重不漏，CUPS 让
"模拟打印"落到真实小票，日结对账是店主每天要用的东西。把它们留在后置阶段，本地产品
就停在"能在开发机上跑通"的水位。

### 2. 追认契约面扩张，并恢复 ADR-15 门禁

上述 14 条命令与 4 条查询**一并追认**，v0.2 命令面基线由 15 条改为 **29 条**。

自本 ADR 之后，ADR-15 的门禁**恢复效力且加一层可执行约束**：

- 新增任何命令或查询，必须在同一 PR 内附带 ADR，或引用一条已存在的 ADR 条目；
- `m2-freeze.test.ts` 的清单变更必须在 PR 描述中点名，不得作为实现的附带修改随手改写。

冻结面不是不能增长，是**增长必须留下裁决记录**。

### 3. 阶段线重述：现在仍然不做

追认不等于阶段线作废。以下**仍不在当前阶段**：

- 云服务器部署、跨设备/多店同步、云侧租户运维
- Windows 打包与实机适配
- Apple 签名、公证与线上分发。**签名发布入口与 A/B 更新机制已具备**
  （`electron-builder.release.yml` 置 `forceCodeSigning: true`），但 Developer ID
  凭据未配置，日常构建与验收走的仍是 `electron-builder.yml`（`identity: null`）——
  **实际产物依然未签名未公证**
- AI / BYOK
- v1 数据迁移
- 会员储值、通知、工厂协同、取送与营销

ADR-14 §4 的第三阶段（云部署与 Windows）不因本 ADR 提前。

### 4. 文档回写是交付的一部分

任何改变对外能力边界的 PR，必须在同一 PR 内完成：

1. `docs/CHANGELOG.md` 面向用户的条目；
2. 若与现行 ADR 的范围陈述冲突——追加 ADR 或修订该 ADR；
3. 若使某份验收记录的"未交付"清单过期——同步订正。

判定"已交付"的口径以 `main` 上的代码与绿灯门禁为准；文档滞后按缺陷处理，不按待办
处理。本条针对的正是本 ADR §背景 3 的情形。

## 后果

- ADR-14 §4「当前阶段不提前实现」清单中的**离线队列、Primary lease、真实打印机**
  三项被本 ADR 覆盖；云同步、AI/BYOK、v1 迁移、Windows 包装四项保持不变。
- v0.2 冻结基线为 29 条命令；`m2-freeze.test.ts` 的清单即基线，改动须点名。
- 里程碑 1 验收记录 §5 与 `CHANGELOG.md` 随本 ADR 同批订正。
- macOS 交付物仍是**未签名未公证**的本地测试包。"签名机制已具备"与"产物已签名"不等价，
  对外表述不得混用——判据是构建走的哪份 electron-builder 配置，不是仓库里有没有发布入口。

## 否决的备选

- **回滚 #121–#123、#125 到 ADR-14 阶段线**：这些能力已带绿灯门禁进入 `main` 并互相耦合，
  回滚代价远大于追认收益，且离线与打印确实是本地产品的必要条件，否决。
- **把阶段线整体作废，改为"按需交付"**：阶段线是防止摊子铺开的唯一机械约束，作废后
  云、Windows、AI 会同时进入关键路径，重演 ADR-13 之前的局面，否决。
- **只改文档、不追认范围**：文档与裁决一致但与代码不一致，等于把分叉从代码搬到裁决，
  否决。
- **保留冻结测试现状（随实现改写）**：该形态无法阻止无裁决扩张，见 §背景 2，否决。
