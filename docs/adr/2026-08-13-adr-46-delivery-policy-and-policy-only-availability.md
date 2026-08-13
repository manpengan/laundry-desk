# ADR-46：门店取送策略与不占位可预约报价

- 日期：2026-08-13
- 状态：**Proposed（实现候选已落地，待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、`0054`、Server delivery policy、Web 设置/报价面、Cloud 合成验收

## 背景

ADR-37 阶段 4.4 需要先建立门店取送的服务范围、时段、运费与可预约规则。当前
`store_features.delivery` 仍是独立的门店能力开关，且尚没有本阶段所需的顾客自助身份、地址、
预约、容量占用或任务派送真源。如果先用一个“可用”按钮伪装这些状态，会把策略校验误当成
已预约、已占位或已启用的交付能力。

因此本 ADR 只交付当前认证门店的策略配置和 policy-only availability quote。报价是可复用的
内部服务边界，为后续员工代客预约与顾客自助面提供规则判断，但本身不接收地址、不识别
顾客、不查已占容量、不保留名额，也不创建预约。

## 决策

### 1. 门店级当前策略

`0054_delivery_policy.sql` 新增每个 `org_id + store_id` 最多一行的 `delivery_policies`
当前投影，包含：

- 0–20 个受控服务区域：小写 ASCII code、名称、启停和整型分运费；
- 0–28 个周时段：ISO 星期 `1..7` 与门店本地分钟边界；
- 是否接受预约、最短提前分钟、最远提前天数、时隙分钟和每格名义上限；
- 乐观 `version`、更新时间和更新员工。

同星期时段不得重叠，每个时段必须可整分为完整时隙。策略若标记接受预约，至少要有一个
已启用区域和一个服务时段。服务端作为权威校验者，持久层的 JSON 投影也必须以同一严格
schema 重新解析，非法历史数据失败关闭。

### 2. 报价只评估策略

`delivery.availability.quote` 接收取件/送回方向、服务区域 code 和 epoch 秒，从认证会话
注入组织/门店，并从服务端读取门店时区、开关与当前策略。回应给出策略版本、开关状态、
可否“提出预约请求”、原因、运费和时隙结束。

判定顺序固定为：

```text
delivery feature 关闭
→ 策略未配置
→ 策略暂停预约
→ 区域不可用
→ 不在提前期限
→ 不在门店本地服务时段
→ 未对齐完整时隙
→ 策略允许提出请求
```

无论结果如何，`capacity_status` 都固定为 `not_checked`。只有最后一种结果才返回运费、
结束时间和每格名义上限；它不是库存/容量承诺、价格锁定、预约或幂等创建凭证。后续预约命令
必须在自己的事务中重新校验策略版本、时间、区域、实际容量和当时开关。

### 3. Feature 保持独立且默认关闭

写入策略不插入或更新 `store_features`，迁移也不 seed 任何 delivery feature 行。因此可以在
开启功能前预先配置，但开关为 false 或 feature 行缺失时，报价必须优先返回
`delivery_disabled` 且 `can_request_appointment=false`。Web 必须直接展示这一边界，不能
因策略的 `accepting_appointments=true` 而显示已启用。

### 4. 契约、风险与权限

新增一写两读：

| 命令/查询                     | 风险 | 权限             | 边界                                            |
| ----------------------------- | ---- | ---------------- | ----------------------------------------------- |
| `delivery.policy.set`         | R5   | `settings_admin` | 另一管理员 step-up、乐观版本、幂等、online-only |
| `delivery.policy.get`         | R0   | `settings_admin` | 当前门店一行、online-only                       |
| `delivery.availability.quote` | R1   | `delivery_read`  | 当前门店一个不占位报价、online-only             |

三者均为 `internal`，不进入 AI 读取/执行清单，不接受客户端租户字段。冻结面从
**58/38 → 59/40**。写命令沿用 `(org_id, store_id, command, idempotency_key)` 持久幂等与
确认 authority；首跳响应丢失后重用同键只返回首次冻结确认卡，不会新建多张卡。乐观版本在同一事务内
CAS；策略与 before/after audit 同事务落地。

一写两读均经过独立的进程内限流，按 session + org + store + command/query 维度摘要分桶；
默认每分钟 10 次写、60 次读，最多 20,000 个活跃桶。超限在领域读写前返回 `429`
与 `Retry-After`，不在限流 key 中保存原始会话或租户标识。

### 5. 数据库、租户与隐私

`delivery_policies` 启用并 FORCE RLS，应用角色必须同时命中会话注入的 `app.org_id` 与
`app.store_id`；门店使用 org + store 复合外键，更新员工使用 org + staff 复合外键。`laundry_app` 只有
`SELECT, INSERT, UPDATE`，显式失去 `DELETE, TRUNCATE`。

本表和契约不包含顾客 id、姓名、手机号、地址、精确坐标、路线、照片或自由文本。区域 code/name
是门店自己的有界运营标签，不是顾客地址或地理编码结果。因此本轮不扩大隐私导出/匿名化面；
如后续把客户地址与区域匹配，必须由顾客身份/地址 ADR 同批扩展隐私生命周期。

### 6. Web 交付面

设置页在有管理权限时展示受控区域、整型分运费、周时段和预约规则，支持失败重试、
乐观版本和 R5 另一管理员复核。同页可以对一个方向、区域和绝对时间执行策略报价，并
展示服务端权威门店时区。页面始终明示“不查已占名额、不保留容量、不创建预约”，功能关闭时
仍可预先配置，但所有报价明确不可预约。

## 验收

1. Contracts 严格拒绝未知字段、重复/越界区域与时段，冻结 59/40，风险、权限、数据分类、
   online-only 和 AI 负向清单准确。
2. Domain 覆盖 feature-off 优先、未配置/暂停/区域/提前期/时段/对齐原因，时区由服务端门店读取，
   容量永远 `not_checked`。
3. `0054` 从空库 apply/replay，RLS/GUC、应用角色权限、JSON 边界、外键和乐观并发通过真实
   PostgreSQL；迁移与策略写入后 `store_features.delivery` 保持原值。
4. Server memory/PG 实现覆盖跨租户隔离、乐观版本、持久幂等、R5 确认、同事务 audit/event；
   一写两读均在领域访问前经过独立限流。
5. Web 在宽/窄屏均可编辑区域、运费、时段和规则，完成 R5 确认，并准确展示 feature-off
   与 policy-only quote 边界。
6. focused Contracts/DB/Server/Web 门禁与 production build 有新鲜证据；真实 PostgreSQL、Browser/Cloud、
   workspace 全量、required CI、精确 `main` 发布与外部/实机验收分别留作后续门禁，未通过不得写成已完成。

## 后果

- 门店可以在不开启功能的前提下先配置取送策略，并用可解释原因校验一个候选时间。
- 策略报价与预约/占位明确分离，后续任务可以复用判定服务，但不能信任旧报价作为写入授权。
- 新增一个 store-scoped 可变配置投影；既有 RLS、确认、幂等和审计设施成为它的权威边界。

## 否决的备选

- **保存配置时自动打开 delivery feature**：混淆配置和能力发布，否决。
- **报价成功即创建预约/占位**：没有顾客、地址和容量真源，否决。
- **把客户端时区作为规则真源**：员工设备可能与门店时区不同，否决；服务端以门店时区判定。
- **现在引入详细街址或精确地理围栏**：需要顾客身份、地址隐私、地理编码和匹配错误模型，否决并后置。
- **把名义每格上限当作实际剩余容量**：本轮没有 reservation ledger，否决；回应必须标明
  `capacity_status=not_checked`。
