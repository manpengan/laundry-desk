# ADR-47：顾客取送预约、改期与取消

- 日期：2026-08-13
- 状态：**Proposed（实现候选已落地，待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 前置：[ADR-46：门店取送策略与不占位报价](2026-08-13-adr-46-delivery-policy-and-policy-only-availability.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、`0055`、Server appointment runtime、顾客档案 Web 面、Cloud 合成验收

## 背景

ADR-46 只能回答一个候选时间是否符合门店规则，明确不查实际占用、不保留名额，也不创建预约。
阶段 4.4 Item 2 需要把员工代顾客发起的取送请求变成权威容量占位，并在顾客变更计划时安全改期
或取消。如果直接相信旧报价或只在浏览器计数，并发请求会超卖；如果复制收件人、电话和详细地址到
预约表，又会无谓扩大隐私删除与泄露面。

本 ADR 交付当前认证门店内的员工操作面。它引用 ADR-42 已有的顾客地址，但不复制地址内容。
顾客本人认证、小程序/公开自助入口和通知偏好仍属于后续顾客自助 Item 10/11，不由本轮伪装。

## 决策

### 1. 预约是真实容量占位，但不是配送订单

`0055_delivery_appointments.sql` 新增 store-scoped `delivery_appointments`。每行保存：

- 不可读的顾客与地址 ID、取件/送回方向、服务区域 code；
- 预约开始/结束、创建时的整型分运费与策略版本快照；
- `scheduled | cancelled` 状态、乐观 `version`、创建/更新/取消员工与时间；
- 五个受控取消原因，不接受自由文本。

一条 `scheduled` 预约占用对应门店的一个起始时隙。取消会保留历史行并释放占用，不做物理删除。
Item 3 的 `delivery_order`、配送任务、司机、接单、路线与交付证据是另一权威状态机；预约不会冒充
配送订单，也不会自动创建任务。

### 2. 创建必须在事务内重新证明所有前提

`delivery.appointment.create` 不接受客户端运费、结束时间、容量或租户字段。服务端先验证：

1. 顾客仍有效，地址属于其有界 canonical merge group 且未退役/清除；
2. delivery feature 开启，当前策略版本与客户端所见版本一致；
3. 区域、提前期、门店时区、服务窗口和时隙对齐仍有效；
4. 同一 canonical 顾客组、方向与时隙没有另一条有效预约；
5. 当前时隙的 `scheduled` 行数低于策略上限。

PostgreSQL 使用由 `org + store + slot` 派生的事务级 advisory lock 串行化同一时隙，再在锁内计数并
插入。门店时区、策略、feature 与地址在同一命令事务内加共享锁复核；地址归属通过既有、有界的
`customer_canonical_group` 证明，从而允许合并后的 canonical 顾客继续使用来源档案的有效地址。业务行、
审计与领域事件复用命令总线事务共同提交或回滚。内存实现只用于 focused 行为测试，不替代真实
PostgreSQL 并发证据。

### 3. 改期原子移动容量

`delivery.appointment.reschedule` 需要预约 ID、顾客 ID、预约 expected version、策略 expected version
和新开始时间。服务端从权威预约读取方向与区域，不允许浏览器借改期偷偷变更服务类型。

事务锁定预约行，并按确定顺序同时锁旧、新时隙；新时隙重新执行当前策略与容量检查，成功后才更新
开始/结束、运费与策略快照并增加版本。任何检查失败都保留旧预约和旧容量占位，不出现先释放后失败。

### 4. 取消保持可用且只追加历史

`delivery.appointment.cancel` 需要预约 ID、顾客 ID、expected version 和受控原因。取消锁定预约行，
只允许 `scheduled → cancelled`，记录取消员工/时间并增加版本。它不重新要求 feature 开启或策略仍
接收预约：门店暂停服务后仍必须能释放已有名额。取消不能恢复原行；如需重新预约，必须以最新策略
重新创建一行并再次经过确认。

`0055` 的 `BEFORE INSERT OR UPDATE` guard 同时把该生命周期下沉到数据库：应用角色不能绕过
`scheduled → scheduled | cancelled`、逐次 `version + 1`、单调更新时间和取消终态，也不能修改预约、租户、
顾客、地址、方向、区域或创建身份/时间。数据库用会话员工 GUC 复核写入员工，并自行盖创建、更新与
取消时间；因此绕过 command handler 的直接 `laundry_app UPDATE` 也不能复活取消行或篡改身份字段。

### 5. 契约、风险、权限与限流

新增三写三读：

| 命令/查询                             | 风险 | 权限             | 边界                                                    |
| ------------------------------------- | ---- | ---------------- | ------------------------------------------------------- |
| `delivery.appointment.create`         | R3   | `delivery_write` | 显式确认、持久幂等、实际容量、online-only               |
| `delivery.appointment.reschedule`     | R3   | `delivery_write` | 显式确认、双版本、原子移动容量、online-only             |
| `delivery.appointment.cancel`         | R3   | `delivery_write` | 显式确认、受控原因、暂停时仍可用、online-only           |
| `delivery.appointment.get`            | R2   | `delivery_read`  | 当前门店单行、PII-linked、online-only                   |
| `delivery.appointment.addresses.list` | R2   | `delivery_read`  | canonical group 有效地址最小投影，最多 100 行、PII      |
| `delivery.appointments.list`          | R2   | `delivery_read`  | 当前门店最多 100 行、可按顾客/状态/时间过滤、PII-linked |

冻结面从 **59/40 → 62/43**。三条写命令沿用 WYSIWYS `confirm_ref` 和
`(org_id, store_id, command, idempotency_key)` 持久去重；首跳丢失后用同键重试只返回同一冻结卡。
两种角色都可以服务顾客，因此 admin/staff 均持有 `delivery_read` 与 `delivery_write`，但服务端权限与
RLS 仍是权威。为让柜台员工读取可选区域与当前策略版本，本 ADR 把 ADR-46 的
`delivery.policy.get` 从 `settings_admin` 修订为只读 `delivery_read`；`delivery.policy.set` 仍是
admin-only R5，读取权限不授予配置能力。六个入口复用 ADR-46 独立 delivery 限流器，超限在领域访问前
返回 `429`。

全部六项都标为 PII/PII-linked 且明确不进入只读 AI 工具面。预约列表默认 50、最多 100，地址列表
最多 100，并按当前门店
限制；不存在无限导出或跨店工作台。

### 6. 租户、隐私和生命周期

`delivery_appointments` 启用并 FORCE RLS，同时匹配会话注入的 `app.org_id` 与 `app.store_id`。
顾客、地址、门店和员工均有租户组合外键；时区以及地址与顾客的 canonical group 归属在命令事务内锁定并
验证。`laundry_app` 只有 `SELECT, INSERT, UPDATE`，显式失去 `DELETE, TRUNCATE`，且上述数据库 guard
阻止应用角色绕过状态机与不可变字段。

预约表不保存姓名、电话、收件人、街址、经纬度、照片、签名或自由文本。Contracts 对顾客/地址 ID
做 redaction，审计只保留预约 ID、方向、区域、时间、金额、状态与版本，并通过
`privacySubjectCustomerId` 绑定既有顾客隐私生命周期。Web 不再把单个 `customer.profile.get` 当作
canonical 地址权威，而是使用专用、限量且去掉收件人/电话字段的地址查询；查询按
`customer_canonical_group` 合并根档案与来源档案的有效地址，不会把正文写入预约、事件或审计 JSON。

### 7. Web 交付面

顾客详情在认证会话内展示预约面。页面同时读取 canonical group 的专用有效地址投影、当前门店策略和
该顾客的有界预约列表；
创建、改期、取消首跳提交严格 Contracts 输入，R3 返回冻结卡后二跳只提交 `confirm_ref`。成功或并发
冲突后都重新读取权威版本。

功能关闭时 UI 禁止新建和改期，但仍展示已有预约并允许取消；服务端仍独立失败关闭。策略暂停接单时
同样禁止创建/改期但保留取消。浏览器本地时间只转换为 epoch，门店时区与规则判定始终由服务端负责。

## 验收

1. Contracts 精确冻结 62/43，严格拒绝租户、运费、容量、自由取消原因和未知字段；专用地址查询只
   返回预约 UI 必需字段，六项
   均 online-only、PII-linked、非 AI，列表有界。
2. `0055` 从 `0054` apply/replay，组合外键、状态约束、唯一索引、FORCE RLS、应用角色权限和持久
   确认去重通过真实 PostgreSQL。
3. 创建覆盖地址归属、feature/策略版本、门店时区规则、重复和容量；并发同槽不会超卖。
4. 改期覆盖预约/策略双版本、确定锁顺序、新槽满时旧槽不丢；取消覆盖受控状态转换、重复取消拒绝和
   feature-off 仍能释放；应用角色直接 UPDATE 无法篡改身份/创建字段、跳号或复活取消行。
5. 三写的预约变化、audit 与 event 同事务；跨组织/门店/顾客 ID 组合失败关闭，任何证据不包含地址
   正文、电话或姓名。
6. Web 覆盖 feature gate、无地址/策略暂停提示、严格 builder、R3 二跳、创建/改期/取消和冲突刷新。
7. focused Contracts/DB/Server/Web 门禁与 production build 有新鲜证据；真实 PostgreSQL、Browser、
   workspace 全量、required CI、合入和 hk-vps 发布必须绑定最终 exact SHA 另行取证。

## 后果

- ADR-46 的 policy-only 报价与真实预约写入职责清晰分离；成功预约才持有实际容量。
- 改期与取消有可审计、乐观并发的最小生命周期，为 Item 3 配送订单提供稳定输入。
- 引入同槽 advisory lock，会把同一门店同一时隙的写入串行化；不同门店/时隙仍可并行。
- 预约引用地址行，因此匿名化或地址退役后的新建会失败关闭；历史预约仍只保留不可读引用与运营快照。

## 否决的备选

- **沿用 policy-only quote 作为容量凭证**：旧报价不查容量且可过期，否决。
- **浏览器先查数量再创建**：存在并发超卖，否决。
- **只靠唯一索引实现每格 N 个名额**：唯一索引只能表达 0/1，无法表达策略可变的 N，否决；采用事务锁计数。
- **改期先取消旧预约再创建新预约**：新槽失败会丢失旧名额，否决；采用单事务原子移动。
- **把详细地址复制进预约**：扩大 PII 与匿名化范围，否决；只引用既有地址 ID。
- **暂停 feature 后禁止取消**：会把名额永久卡住，否决；取消不依赖 feature/policy 开启。
- **现在交付公开顾客自助或配送任务**：缺少顾客认证、通知偏好和 Item 3 状态机，否决并后置。
