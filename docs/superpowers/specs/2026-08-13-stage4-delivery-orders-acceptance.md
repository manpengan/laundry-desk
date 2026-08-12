# 阶段 4.4 Item 3 权威配送订单与状态机验收记录

> 日期：2026-08-13
> 状态：**隔离工作树候选实现与本地门禁已通过；独立审查、Browser、CI、合入与发布尚未形成证据**
> 决策：[ADR-48](../../adr/2026-08-13-adr-48-authoritative-delivery-orders.md)（Proposed，待 manpengan 签署）
> 前置提交：Item 2 `f9011abfbe1233e3c96dc7e69f757872180e80d4`
> 实现基线：本记录与 Item 3 单一提交同批

## 1. 范围

本记录只覆盖当前认证门店内，把既有洗衣订单、canonical 顾客和取/送预约绑定为唯一活动
`delivery_order`，并由数据库强制上门取件、到店、送回或顾客自取的完整生命周期。员工 Web 工作台
提供有界列表、详情与合法下一步；洗衣订单、件级状态、余额、预约费用和 feature 继续作为各自权威。

不包含配送任务分派、司机接单/转派、人工接管、移动 H5、路线、GPS、照片、签名、通知、顾客本人
认证/公开自助、离线/Edge 或第三方 provider。这些分别属于后续 Item 4–6、10/11，不能用本记录替代。

## 2. 关闭矩阵

| 层级             | Item 3 目标                                                        | 候选状态                   |
| ---------------- | ------------------------------------------------------------------ | -------------------------- |
| ADR/Domain       | 三种路线、显式全状态转换、取消边界、终态与洗衣订单权威关系         | 本地门禁已通过；待独立审查 |
| Contracts        | 2 commands + 2 queries、64/45、R3/R2、严格边界、非 AI              | focused 与 OpenAPI 已通过  |
| Schema/RLS       | 0056 组合外键、费用快照、CAS/DB time、终态不可逆、FORCE RLS        | fresh 真实 PG 已通过       |
| Server           | memory/PG、canonical merge、feature gate、幂等、audit/event 同事务 | focused 与真实 PG 已通过   |
| Web              | 员工列表、详情、合法状态推进、R3 确认、feature 降级                | focused、构建与 SPA 已通过 |
| External/release | 完整迁移链、Browser、required CI、合入与 hk-vps exact-SHA 发布     | 未执行，不宣称交付         |

## 3. 不可替代的验收证据

- 预约成功只证明容量占位，不等于已经创建配送订单；只有 `delivery.order.create` 成功才产生权威生命周期。
- 配送订单状态不等于任务状态；本轮没有司机、任务分派、接单、转派或人工接管真源。
- `return_in_progress -> completed` 只在既有订单已关闭、件级权威已是 `delivered` 且余额为零时成立；
  按钮或配送订单自己不能制造件级交付事实。顾客自取同理要求既有件级 `picked_up`。
- memory CAS 不等于 PostgreSQL 并发与 direct app-role guard；必须在真实 PostgreSQL 分别证明。
- UI 只展示合法按钮不等于状态机成立；Domain、Server CAS、数据库 guard 和终态约束必须分别通过。
- focused test/build 不等于 Browser、required CI、合入或 hk-vps 发布。

## 4. 行为矩阵

### 4.1 路线与状态机

- `pickup + delivery`：取件和送回预约均必需，从 `pickup_scheduled` 开始。
- `pickup + self_pickup`：只允许取件预约，从 `pickup_scheduled` 开始。
- `store_dropoff + delivery`：只允许送回预约，从 `at_store` 开始。
- `store_dropoff + self_pickup`：无配送腿，严格拒绝并继续走既有柜台流程。
- 取件按 `pickup_scheduled -> pickup_in_progress -> picked_up -> at_store` 逐步推进。
- 送回按 `at_store -> return_scheduled -> return_in_progress -> completed` 逐步推进。
- 自取按 `at_store -> self_pickup_ready -> completed` 逐步推进。
- 普通取消只来自 `pickup_scheduled`、`pickup_in_progress`、`at_store`、`return_scheduled`；
  `picked_up`、`return_in_progress` 和两个终态均不能取消或复活。

### 4.2 权威关联与数据库边界

- create 不接受租户、费用、初态、版本或时间；服务端/数据库从会话、路线、洗衣订单与预约派生。
- 上门取件绑定同店 `draft` 洗衣订单；到店送洗绑定同店 `open` 洗衣订单。订单、预约、顾客或地址
  间接归属跨组织/门店时均失败关闭。
- 顾客输入与洗衣订单、预约按 canonical group 比较；历史顾客 ID 不因合并改写，合并后的来源/根输入
  都能继续读取和转换同一配送订单。
- 同一洗衣订单只有一个活动配送订单，每条预约只绑定一次；相同幂等 create 重放不会产生第二行。
- 绑定预约是不可变历史输入；不能借预约改期或取消改变配送订单路线、费用或关联。
- `0056` guard 强制逐次版本、数据库时间、会话员工、身份/创建字段不可变、精确转换与不可逆终态；
  应用角色无 DELETE/TRUNCATE。
- 开始返件前锁内复核订单仍为 open、至少一件、全部衣物已准备且没有活动生产批次。完成前复核余额为
  零且件级终态与 delivery/self-pickup 路线一致；配送命令本身不代写衣物或账务。

### 4.3 Contracts、Server 与 Web

- 两写均为 online-only R3、显式确认、持久幂等；两读为 online-only R2，列表默认 50、最多 100。
- 四项为 PII/PII-linked 且不进入 AI 面；审计/事件只保留 opaque 关联、路线、金额、状态、版本与受控
  原因，不保存姓名、电话、地址正文、路线、GPS、照片或签名。
- 新建时 delivery feature 必须开启；关闭后既有订单仍可读取、推进或取消，避免冻结在途保管责任。
- 命令/查询使用 delivery 专用限流器，并在任何领域访问前返回 `429`。
- Web 从 Contracts 构造输入并解析响应，只展示服务端状态允许的下一步；R3 二跳只提交
  `confirm_ref`，成功或冲突后重读权威行。

## 5. 新鲜证据

同一隔离工作树在 2026-08-13 形成以下新鲜证据：

- Domain 188/188、Contracts 807/807、DB 94/94；Server delivery focused 9 通过、真实 PG 1 项在
  非 PG focused 环境按预期跳过；Web delivery/权限/路由 focused 24/24。
- `pnpm workspace:typecheck` 12/12、`pnpm workspace:build` 9/9；Server 与 Web production build
  均通过。
- OpenAPI 由当前 Contracts 重新生成；Edge SPA `SPA_SYNC_OK entries=3`、`SPA_CHECK_OK entries=3`。
- `pnpm local:commissioning:fresh:pg` 从空卷 apply `0001 -> 0056`，记录 56 项正式迁移；真实 PG
  Item 3 行为 1/1，输出 `ADR48_DELIVERY_ORDERS_PG_ACCEPTANCE_OK`。
- 同一 fresh 链通过 schema/RLS/ACL/function catalog 与 write gate：0056 catalog 为 1299 项、摘要
  `f466ee36ce5623a98cd72ff1ef7221fea85753e242ed9a4c830c3d658ee6fcf7`；最终输出
  `LOCAL_FRESH_COMMISSIONING_ACCEPTANCE_OK modes=pg`，随后精确清理容器、网络、卷和临时配置。
- 真实 PG 覆盖 canonical merge、预约/订单/顾客/地址归属、重复 create、CAS 并发、非法跳转、终态
  复活、身份/created 篡改、直接 app-role UPDATE、feature-off 收尾和跨租户/跨门店 fail-closed。
- Browser、required CI、合入、hk-vps exact-SHA 发布及独立审查仍未执行，不能由上述本地证据替代。

## 6. 完成判定

Item 3 代码候选只有在上述 focused 与真实 PostgreSQL 结果属于最终工作树、ADR-48 与 64/45 冻结面
一致、生产文件低于 400 physical lines、测试低于 800 lines、独立审查缺陷已关闭且相对 Item 2 恰好
形成一个 commit 时，才能交给父任务集成。只有后续 Browser、required CI、合入、数据库迁移和 hk-vps
公网验收全部绑定最终 exact SHA，才可把“生产已发布”写入本记录。
