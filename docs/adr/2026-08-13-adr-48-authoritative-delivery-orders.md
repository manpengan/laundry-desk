# ADR-48：权威配送订单与取送生命周期

- 日期：2026-08-13
- 状态：**Proposed（实现候选开发中，待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 前置：[ADR-47：顾客取送预约、改期与取消](2026-08-13-adr-47-customer-delivery-appointments.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、Domain、`0056`、Server delivery-order runtime、员工 Web 工作台、Cloud 合成验收

## 背景

ADR-46/47 已分别建立门店规则和真实预约容量，但预约只说明“何时上门”，不能回答衣物是否已取、
是否进店、何时开始送回或整个取送流程是否终结。若让预约状态、配送任务或浏览器按钮各自推断这些
事实，会出现多个可写真源；若配送完成直接代替既有件级洗护状态，又会绕开订单结清与衣物终态。

阶段 4.4 Item 3 因此建立独立、store-scoped 的 `delivery_orders` 权威订单。它绑定既有洗衣订单、
canonical 顾客和可选的取/送预约，但不创建司机任务，也不保存照片、签名、GPS 或路线。任务分派属于
Item 4，移动任务面属于 Item 5，交付证据属于 Item 6。

## 决策

### 1. 一张洗衣订单只有一个活动配送订单

`0056_delivery_orders.sql` 新增 `delivery_orders`。每行保存：

- 当前组织、门店、洗衣订单和 canonical 顾客的 opaque ID；
- `pickup | store_dropoff` 收件方式与 `delivery | self_pickup` 返件方式；
- 与实际配送腿一一对应的取件/送回预约引用；
- 从预约派生的取件、返件和总运费整型分快照；
- 权威状态、乐观 `version`、受控取消原因、创建/更新/终结员工和数据库时间。

同一门店的一张洗衣订单最多有一个非终态配送订单；一条预约只能绑定一次。终态历史保留且不可物理
删除。创建时服务端和数据库共同锁定并证明：delivery feature 已启用，洗衣订单、顾客和预约属于当前
组织/门店，输入顾客与洗衣订单处于同一 canonical group，预约仍为 `scheduled`、方向匹配且未被使用。
运费、canonical 顾客、初始状态、版本和时间均由服务端/数据库派生，客户端不能提交。

### 2. 三种受支持路线与洗衣订单边界

支持的路线固定为：

| 收件方式        | 返件方式      | 必要预约    | 初始状态           |
| --------------- | ------------- | ----------- | ------------------ |
| `pickup`        | `delivery`    | 取件 + 送回 | `pickup_scheduled` |
| `pickup`        | `self_pickup` | 仅取件      | `pickup_scheduled` |
| `store_dropoff` | `delivery`    | 仅送回      | `at_store`         |

`store_dropoff + self_pickup` 没有任何配送腿，不得创建 `delivery_order`，继续使用既有柜台洗衣订单流程。
上门取件可绑定尚未正式收件的 `draft` 洗衣订单；到店送洗必须绑定已正式收件的 `open` 订单。配送状态不
擅自修改洗衣订单或衣物：取件到店后仍须由现有柜台/件级命令完成正式收件与洗护；开始返件前要求订单为
`open`、至少一件衣物已满足返件准备条件且没有活动生产批次；完成前要求既有订单已 `closed`、余额为
零，全部衣物已经由既有件级权威变为本路线对应的 `delivered` 或 `picked_up`（`lost` 作为既有异常
终态保留）。

顾客后续合并不改写历史 `customer_id`。读取、过滤与转换重新解析记录和输入的 canonical root，使来源
档案或新根档案都能继续访问同一配送订单；匿名化后的根档案不能创建新单。

### 3. 完整、显式且不可逆的状态机

数据库与 Domain 使用同一允许表：

```text
上门取件：pickup_scheduled -> pickup_in_progress -> picked_up -> at_store
送回到家：at_store -> return_scheduled -> return_in_progress -> completed
顾客自取：at_store -> self_pickup_ready -> completed
```

取消只允许从 `pickup_scheduled`、`pickup_in_progress`、`at_store` 或 `return_scheduled` 进入
`cancelled`。`picked_up` 已形成在途保管责任，`return_in_progress` 已进入最后交付，二者不能用普通取消
跳过回店/完成处置。`completed` 与 `cancelled` 都是不可逆终态；重复转换、跳步、同状态写入和终态复活
全部拒绝。

转换需要 `delivery_order_id + customer_id + expected_version + target_status`；只有取消附带受控 reason
code。PostgreSQL 行锁与 `WHERE version = expected_version AND status = current` 提供 CAS，成功仅增加
一次版本；`0056` 的写 guard 再强制合法边、`version + 1`、不可变租户/身份/预约/费用/创建字段、会话
员工和数据库单调时间。即使绕过 handler 以 `laundry_app UPDATE` 写表，也不能跳转、复活终态或伪造
创建/终结时间。

绑定后预约成为本单的历史输入，不允许再改期或直接取消；配送订单的取消保留这份已消费预约证据，不
把旧预约重新解释为可复用授权。若顾客需要新时段，必须以新预约和新配送订单重新经过容量、确认与
幂等边界。

### 4. 契约、风险、权限与限流

新增两写两读：

| 命令/查询                   | 风险 | 权限             | 边界                                                |
| --------------------------- | ---- | ---------------- | --------------------------------------------------- |
| `delivery.order.create`     | R3   | `delivery_write` | 显式确认、持久幂等、权威关联与费用派生、online-only |
| `delivery.order.transition` | R3   | `delivery_write` | 显式确认、CAS、数据库状态机和终态前置、online-only  |
| `delivery.order.get`        | R2   | `delivery_read`  | 当前门店单行、PII-linked、online-only               |
| `delivery.orders.list`      | R2   | `delivery_read`  | 当前门店最多 100 行，可按顾客/洗衣订单/状态过滤     |

冻结面从 **62/43 -> 64/45**。两条写命令复用 WYSIWYS `confirm_ref` 与
`(org_id, store_id, command, idempotency_key)` 持久去重；相同 create 重放只返回第一次冻结或已提交
结果，不生成第二张配送订单。四个入口复用 delivery 专用 session/org/store/kind 限流器，并在领域读取或
写入前拒绝超限。

四项均为内部 PII/PII-linked 能力且不进入 AI 工具清单。Contracts 严格拒绝租户、费用、状态、版本
派生字段、地址正文、电话、姓名、任务、司机、坐标和证据字段；租户只能由认证会话注入。

### 5. 事务、RLS、审计与事件

`delivery_orders` 启用并 FORCE RLS，应用角色必须同时命中会话 `app.org_id` 和 `app.store_id`。
洗衣订单、预约、门店和员工使用组织/门店组合外键；`laundry_app` 只有 `SELECT, INSERT, UPDATE`，
显式失去 `DELETE, TRUNCATE`。业务行、R3 持久确认/幂等、before/after audit 和领域事件复用命令总线
同一事务，任一失败共同回滚。

审计和事件只保存 opaque 关联、路线、整型分费用、状态、版本与受控原因，不复制预约地址或顾客联系
信息；`privacySubjectCustomerId` 使配送记录进入既有顾客隐私串行化边界。历史关联不因顾客合并被
覆盖，读取按 canonical group 解析。

### 6. 员工 Web 工作台

认证后的员工导航新增“取送订单”。工作台读取当前门店有界列表，可按状态筛选，展示路线、关联洗衣
订单、预约、费用和权威版本；详情只提供当前状态允许的下一步按钮。按钮提交严格 Contracts 输入，R3
首跳展示冻结确认卡，二跳只携带 `confirm_ref`。成功或冲突后重新读取权威详情/列表，不在浏览器推断
新版本或完成条件。

feature 关闭时不允许新建配送订单，但既有订单仍可查询并推进或取消，避免开关暂停把在途衣物冻结。
UI gate 只改善提示；RBAC、会话租户、Server 重验与 FORCE RLS 仍分别成立。

## 验收

1. Contracts 精确冻结 64/45，四个边界严格、有界、online-only、PII-linked、非 AI；create/transition
   为 R3 确认与持久幂等，拒绝客户端租户、费用、派生状态和证据字段。
2. `0056` 从 `0001 -> 0056` apply/replay；组合外键、活动唯一性、预约单次绑定、FORCE RLS、应用角色
   权限、函数权限和持久确认去重在真实 PostgreSQL 通过。
3. 三种路线覆盖精确初态与全部合法边；非法跳步、同状态写、CAS 并发、终态复活、身份/created 字段
   篡改以及直接应用角色 UPDATE 绕过均失败关闭。
4. 创建覆盖跨组织/门店订单、顾客、地址间接归属和预约方向/状态，重复 create 幂等；顾客合并前后从
   来源或根档案均可读取/转换，匿名化根不能新建。
5. 返件准备和完成分别由既有洗衣订单/件级权威阻断；feature-off 拒绝新建但不阻断既有状态收尾。
6. 两写的业务变化、audit 与 event 同事务，事件/审计无姓名、电话、地址正文、GPS、照片或签名。
7. Web 覆盖有界列表、详情、合法下一步、R3 二跳、冲突刷新、feature-off 提示和员工权限。
8. focused Contracts/DB/Domain/Server/Web、真实 PostgreSQL 迁移链与 production build 有新鲜证据；
   Browser、required CI、合入和 hk-vps 发布必须绑定最终 exact SHA 独立取证。

## 后果

- 预约、配送订单、任务和交付证据成为四个清晰层级；本 ADR 只交付第二层权威生命周期。
- 配送完成不能越权替代件级交付或结清，避免物流 UI 制造账务/衣物假终态。
- 绑定预约保留为不可变历史输入，取消订单不会悄悄释放或重写一项可能已经执行的预约。
- feature 开关只控制新建，不中断已有取送责任的安全收尾。

## 否决的备选

- **直接给预约增加“配送中/完成”状态**：预约是容量账本，不是衣物保管或物流真源，否决。
- **让任务状态成为配送订单真源**：Item 4 尚未存在，且人工接管会产生多个任务，否决。
- **创建时接受客户端运费或初态**：可绕过策略快照与路线约束，否决；从预约/路线派生。
- **配送完成顺便修改所有衣物和订单**：绕开既有件级状态机、支付与审计命令，否决；只验证权威终态。
- **feature 关闭后禁止收尾**：会冻结已取走衣物，否决；只阻断新建。
- **现在保存司机、路线、GPS、照片或签名**：分别属于 Item 4/6，否决并后置。
