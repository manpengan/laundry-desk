# ADR-49：配送任务分派、接单、转派与人工接管

- 日期：2026-08-13
- 状态：**Proposed（实现候选与独立安全审查已完成，待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 前置：[ADR-48：权威配送订单与取送生命周期](2026-08-13-adr-48-authoritative-delivery-orders.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、Domain、`0057`、Server delivery-task runtime、员工 Web 工作台、真实 PostgreSQL 验收

## 背景

ADR-48 的 `delivery_order` 是取送路线进度真源，但没有回答当前由谁执行某一条实际配送腿，也没有保存
拒绝、转派或紧急接管的保管历史。若直接改写订单上的“配送员”字段，旧责任会被覆盖；若让任务按钮
自行推进订单，又会制造第二个路线真源。

阶段 4.4 Item 4 因此新增独立 `delivery_task` 权威链，只表达某个配送订单腿的当前执行人和不可变分派
历史。它不保存路线、GPS、照片、签名、地址正文或第三方 provider payload；这些仍属于 Item 5/6。

## 决策

### 1. 任务绑定订单腿，订单保持路线真源

`0057_delivery_tasks.sql` 新增 store-scoped `delivery_tasks`。每行绑定同店 `delivery_order_id + leg`，
保存受派员工、分派员工、来源、前驱、状态、逐次版本、受控原因和数据库时间。同一订单腿同时最多一条
`offered | accepted` 活动任务；终态历史不可修改、删除或复活，一条前驱最多对应一个 successor。

只有订单路线实际包含的 `pickup | return` 腿才能创建任务。首次分派要求订单处于该腿的 scheduled
状态；拒绝或订单取消前形成的可复用终态可作为后续 assignment 前驱。feature 只控制新配送订单，不得
阻断既有 scheduled/in-progress 腿的任务分派、响应或安全收口。

任务不能代写路线进度。只有当前 `accepted` 任务的受派员工可以执行订单的取件开始/取到或送回开始/
完成边；订单到达 `picked_up`/`completed` 后，同事务把对应 accepted 任务置为 `completed`。订单取消则
同事务取消其 offered/accepted 任务。应用角色直接把任务写成 completed/cancelled，若订单真源不匹配，
提交时失败。

### 2. 显式保管状态机与 successor 完整性

状态机固定为：

```text
offered -> accepted | rejected | transferred | taken_over | cancelled
accepted -> transferred | taken_over | completed | cancelled
terminal -> no transition
```

`assign` 创建 offered；只有当前受派人可以 accept/reject，拒绝必须提交受控原因。`transfer` 为管理员 R3：
旧任务进入 transferred，同事务创建指向另一 active 员工的 offered successor。`takeover` 为管理员 R4：
旧任务进入 taken_over，同事务创建指向当前接管管理员的 accepted successor，且必须由另一 active 管理员
复核。转派/接管目标不得仍是原受派人。

延迟约束触发器在事务提交时验证 transferred/taken_over 必有同订单、同腿、正确 source/status 的唯一
successor。因此应用角色即使绕过 Server，也不能只终结旧任务而留下无 active successor 的责任空洞。

### 3. 锁序、CAS、员工权限和数据库防线

所有写路径遵循 `delivery_order -> delivery_task -> staff` 锁序。输入携带订单版本以及既有任务版本；
Server 在锁内重新验证，SQL 更新要求 `version = expected_version`，成功只增加一次版本。数据库写 guard
覆盖同一状态边、`version + 1`、身份/创建字段不可变、会话 actor、一致的原因与数据库单调时间。

分派、转派和接管 actor 必须是当前门店 active admin；目标必须是当前门店 active staff。接受、拒绝和
配送执行只属于当前 assignee。`delivery_tasks` 启用并 FORCE RLS，`laundry_app` 只有
`SELECT, INSERT, UPDATE`，显式失去 `DELETE, TRUNCATE`；guard 函数不向 PUBLIC 开放。组合外键和会话
GUC 同时阻断跨组织/门店引用。

### 4. 契约、确认、幂等、审计与事件

新增四写两读：

| 命令/查询                | 风险 | 权限                | 边界                                             |
| ------------------------ | ---- | ------------------- | ------------------------------------------------ |
| `delivery.task.assign`   | R3   | `delivery_assign`   | 当前订单腿、active 员工、订单 CAS、online-only   |
| `delivery.task.respond`  | R3   | `delivery_write`    | 当前 assignee、任务 CAS、受控拒绝原因            |
| `delivery.task.transfer` | R3   | `delivery_assign`   | active admin、原子终结旧任务并创建 offered 后继  |
| `delivery.task.takeover` | R4   | `delivery_takeover` | active admin、另一管理员复核、accepted 后继      |
| `delivery.task.get`      | R2   | `delivery_read`     | 当前门店单行、PII-linked、online-only            |
| `delivery.tasks.list`    | R2   | `delivery_read`     | 当前门店最多 100 行，可按订单/腿/受派人/状态过滤 |

冻结面从 **64/45 -> 68/47**。所有写命令都使用服务端从锁内订单/任务/员工状态派生的 WYSIWYS 卡；二跳
只接收 `confirm_ref`，并重新验证冻结摘要、订单版本、任务版本和 actor。R4 takeover 必须由不同管理员
批准。相同 `(org_id, store_id, command, idempotency_key)` 复用持久 pending/action 结果。

任务记录属于内部 PII-linked 数据，不进入 AI 工具面。业务变化、before/after audit 和领域 event 在命令
总线同一 PostgreSQL 事务；失败共同回滚，event 只在 commit 后发布。隐私 owner 从关联配送订单的
canonical customer 由 Server 派生，客户端不能提交租户或 customer。

### 5. 员工 Web 工作台

认证后的“取送”页面在权威订单工作台旁增加任务页：有界读取任务和可分派订单腿，支持 active/我的
任务筛选；管理员可以选择 active 员工进行分派或转派，受派人可接受/拒绝，管理员可发起 R4 人工接管。
所有危险动作展示服务端冻结摘要；摘要缺失、类型错误或已过期时失败关闭，成功或冲突后重读权威列表。

该响应式员工 Web 在 Item 4 当时不是配送员移动 H5。后续
[ADR-50](2026-08-13-adr-50-mobile-delivery-task-h5.md) 已增加隔离的 `/mobile/tasks` 当前员工任务面，
但不改变本 ADR 的任务权威、桌面管理员能力或 68/47 契约；离线写、路线导航、后台定位和现场证据仍未
包含。

## 验收

1. Contracts 精确冻结 68/47；四写两读严格、有界、online-only、PII-linked、非 AI，拒绝租户、状态、
   successor、时间和顾客等服务端字段。
2. `0057` 从空库完整 apply/replay；组合外键、活动腿唯一性、前驱唯一性、FORCE RLS、ACL、函数权限和
   pending 幂等索引在真实 PostgreSQL 通过。
3. assign/respond/transfer/takeover 全状态边、active staff/admin、CAS、锁序、受控原因和数据库时间分别
   有 Domain、memory、PG 证据。
4. 应用角色孤立 transferred/taken_over、脱离订单真源的 completed/cancelled、错误 assignee 执行订单、
   跨门店读取、终态修改与 DELETE/TRUNCATE 均失败关闭；合法 successor 与 order -> task 收口成功。
5. R3/R4 首跳只创建冻结 WYSIWYS 卡；R4 明确要求另一管理员；二跳重验同一 authority。业务、audit 和
   event 同事务，event 只在提交后发布且不含地址正文、电话、GPS、照片或签名。
6. feature-off 不创建新配送订单，但既有订单腿仍可分派和收口；Web 覆盖列表、详情、分派、响应、转派、
   takeover、冲突刷新和失败关闭摘要。
7. focused Contracts/DB/Domain/Server/Web、真实 PostgreSQL、OpenAPI、lint/type/build/size 有新鲜证据；
   Browser、required CI、合入和 hk-vps 发布必须绑定最终 exact SHA 独立取证。

## 后果

- 配送订单继续回答“路线走到哪”，任务只回答“当前谁负责”和“责任如何交接”，避免双真源。
- 每次转派/接管保留不可变前驱，既能追责，也不会覆盖旧任务或在事务中留下责任空洞。
- feature-off 仍允许既有责任闭环，避免运营开关冻结在途衣物。
- 任务没有现场交付证据；Item 6 必须另立权威表与采集/保留策略，不能向本表塞自由 payload。

## 否决的备选

- **直接改写订单上的配送员**：覆盖历史且无法表达拒绝/接管链，否决。
- **任务自行成为配送路线真源**：会与 ADR-48 冲突，否决；完成/取消只能跟随订单真源。
- **转派只改 assignee**：无法保存旧责任，否决；终结旧任务并原子创建 successor。
- **允许任意员工接管**：会静默劫持保管责任，否决；active admin + R4 另一管理员复核。
- **feature 关闭后禁止已有任务**：会冻结在途责任，否决；只阻断新配送订单。
- **本轮加入移动 H5、GPS、照片或签名**：Item 4 当时因独立客户端、隐私与证据生命周期而后置；
  后续 ADR-50 只交付移动 H5，GPS、照片、签名和交付证据继续留给 Item 6。
