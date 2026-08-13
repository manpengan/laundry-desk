# 阶段 4.4 Item 4 配送任务分派与保管链验收记录

> 日期：2026-08-13
> 状态：**隔离工作树候选实现、本地门禁与独立安全审查已通过；合入与发布尚未形成证据**
> 决策：[ADR-49](../../adr/2026-08-13-adr-49-authoritative-delivery-tasks.md)（Proposed，待 manpengan 签署）
> 前置提交：Item 3 `ca340bd0c6a96e28783ec68c08b5c984ac486250`
> 实现基线：本记录与 Item 4 单一提交同批

## 1. 范围

本记录只覆盖当前认证门店内，以权威配送订单腿为边界的任务分派、受派人接单/拒绝、管理员转派和
R4 人工接管。`delivery_order` 继续作为路线进度真源，`delivery_task` 只保存执行保管关系和不可变
successor 历史。

本记录在 Item 4 验收时不包含 Item 5 配送员移动 H5；该历史边界现由
[ADR-50](../../adr/2026-08-13-adr-50-mobile-delivery-task-h5.md)及其独立验收记录追加，而不是回写为
Item 4 证据。Item 6 路线导航、GPS、照片、签名或其他交付证据仍不包含；顾客公开自助、离线写/
Edge 或第三方配送 provider 也仍需独立门禁。桌面员工 Web 的响应式布局本身不替代移动验收。

## 2. 关闭矩阵

| 层级             | Item 4 目标                                                   | 候选状态               |
| ---------------- | ------------------------------------------------------------- | ---------------------- |
| ADR/Domain       | 明确状态机、订单/任务权威关系、successor 与 feature-off 边界  | 本地门禁与独立审查通过 |
| Contracts        | 4 commands + 2 queries、68/47、R3/R4/R2、严格 WYSIWYS、非 AI  | 811/811 通过           |
| Schema/RLS       | 0057 组合 FK、CAS/DB time、延迟完整性、FORCE RLS、ACL         | 真实 PG 通过           |
| Server           | memory/PG、锁序、active staff/admin、幂等、audit/event 同事务 | 952 通过、93 PG 跳过   |
| Web              | 列表、分派、响应、转派、R4 接管、冲突刷新、feature-off 提示   | build 与 428/428 通过  |
| External/release | Browser、required CI、合入与 hk-vps exact-SHA 发布            | 未执行，不宣称交付     |

## 3. 不可替代的验收证据

- 有任务不等于订单已推进；只有 ADR-48 的订单转换才是路线事实。
- memory 成功不等于数据库 direct app-role guard、RLS、延迟 successor 完整性或真实事务成功。
- 一次 UPDATE 成为 transferred/taken_over 不等于转派成功；提交时必须存在同腿合法 successor。
- UI 隐藏按钮不等于权限成立；RBAC、Server 锁内重验、数据库 actor/active staff guard 与 RLS 必须分别成立。
- R4 卡片存在不等于复核有效；二跳必须证明另一 active 管理员且绑定原冻结 authority。
- focused/build 不等于 Browser、required CI、合入或 hk-vps 发布。

## 4. 行为矩阵

- 首次 assign 只来自匹配路线的 scheduled 腿；拒绝/取消后的 reoffer 绑定唯一可复用前驱。
- 同订单腿最多一条 offered/accepted；assignee 必须是当前门店 active staff，actor 必须是 active admin。
- 只有 offered 的当前 assignee 可接受或带受控原因拒绝；版本或 actor 不匹配均失败关闭。
- transfer 原子终结旧任务并创建不同员工的 offered successor；takeover 原子创建当前管理员的 accepted
  successor，并要求 R4 另一管理员。
- accepted assignee 才能推进实际订单腿；订单到达 pickup/return 终点或取消时同事务收口活动任务。
- direct app-role 不能孤立转派/接管、伪造完成/取消、修改终态、跨门店访问或物理删除。
- feature-off 不阻断既有 scheduled/in-progress 腿的分派、响应、转派、接管或订单驱动收口。
- audit/event 只包含 opaque task/order/staff id、腿、状态、版本与受控原因；不包含地址正文、电话或证据。

## 5. 新鲜证据

以下结果均来自基于 Item 3 `ca340bd0c6a96e28783ec68c08b5c984ac486250` 的同一隔离工作树：

- Contracts：全量 `811/811`；Domain：全量 `190/190`；DB：全量 `99/99`。
- Server：全量 `1045` 项中 `952` 通过、`93` 个显式真实 PG 场景在普通单元测试入口跳过；Item 4 focused
  `21` 通过、`1` 个真实 PG 场景按设计跳过。Web：build 与 `428/428` 通过；R4 step-up 的异步
  challenge/verify 在关闭或 authority 切换后不能回流旧确认。
- `pnpm workspace:format:check`、`pnpm workspace:lint`、`pnpm workspace:typecheck`、
  `pnpm workspace:build` 全部通过；OpenAPI 已由冻结契约重新生成。
- workspace 根级 Node 门禁 `278/278` 通过，随后 Turborepo `test` 的 `12/12` tasks 通过；同步后的
  content-addressed Web SPA 也通过 Edge `SPA_CHECK_OK entries=3` 与 `404/404` 测试。
- production JS/TS 本次触及文件最大 `400` physical lines，新文件最大 `381`；测试文件最大 `786`，分别
  未超过 `400/800` 门禁。
- `pnpm local:commissioning:fresh:pg` 从空卷顺序应用 `0001 -> 0057`，Item 3 与 Item 4 真实 PG 场景各
  `1/1` 通过，并产生 `ADR49_DELIVERY_TASKS_PG_ACCEPTANCE_OK` 与
  `LOCAL_FRESH_COMMISSIONING_ACCEPTANCE_OK modes=pg`。
- 最终集成链（含 Item 1 的 0054 安全 guard）golden catalog 为 `entries=1322`、
  `sha256=6805b93cbfe5649eaeac9d43fb03d9212e2d93092a944e6b53c8363df0dc15e7`；runner 最终删除隔离
  container、network、volume 与临时 compose config，commissioning 端口已释放。
- 独立 security review 对最终候选给出 **APPROVE**，`P0/P1/P2 = 0`；批准前的 step-up 异步 authority
  hardening 已纳入上述 Web 回归与重新生成的 content-addressed Edge SPA。

这些是本地候选证据，不替代 Browser、required CI、合入或 hk-vps exact-SHA 发布。

## 6. 完成判定

Item 4 代码候选只有在 focused 与真实 PostgreSQL 结果属于最终工作树、ADR-49 与 68/47 冻结面一致、
生产 JS/TS 文件不超过 400 physical lines、测试不超过 800 lines、独立安全审查缺陷已关闭且相对 Item 3
恰好形成一个 commit 时，才能交给父任务集成。Browser、required CI、合入、数据库迁移和 hk-vps 公网
验收必须后续绑定最终 exact SHA，不能由本记录预先宣称。
