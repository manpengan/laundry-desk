# ADR-44：Provider-neutral 通知 outbox、回执与人工降级

- 日期：2026-08-12
- 状态：**Accepted（software-only 实现获准；真实 provider 仍受外部证据门禁）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 前序：[ADR-23：催取工作台与人工通知名单](2026-08-07-adr-23-pickup-reminder-manual-list.md)
- 隐私：[ADR-42：顾客扩展档案与政策](2026-08-12-adr-42-customer-extended-profiles-and-discount-policy.md)
- 影响：通知 Contracts、`0052`、Server 后台 worker、催取 Web、Cloud 合成验收

## 背景

ADR-23 已交付服务端权威的催取候选和人工 CSV，但明确不发送、不计费、不声称送达。ADR-37
阶段 4 要求下一步建立 provider-neutral 状态机、outbox、幂等、重试、回执映射和失败降级；同时
规定 fake adapter 只能形成 `software_only`，真实短信/微信完成声明必须另有账号、模板、费用、
请求、回执/webhook 和失败证据。

本阶段没有真实短信或微信凭据、获批模板、额度和 callback 授权。因此先交付可替换的业务内核与
清晰标注的软件模拟 adapter，不在公网挂载伪造 provider webhook，也不把模拟接单显示成“已发送”
或“已送达”。

## 决策

### 1. ADR-23 人工名单保持独立真源

`notification.manual_list.create`、`notification_log` 和现有 CSV 语义不变。人工名单仍只表示
“名单已生成”，不与 provider delivery 共用状态，也不因本 ADR 回填“已联系”。

新增自动执行面只在管理员明确入队后由后台 worker 发送；本片不做无人值守的受众选择、定时批量
建单或营销群发。provider 不可用、永久失败、重试耗尽或目标快照漂移时，订单进入
`manual_required`，Web 可把这些订单重新带回 ADR-23 人工名单。

### 2. 契约面新增一写三读

- `notification.delivery_batch.enqueue`：在线-only、PII、幂等；只接受 1–50 个当前催取候选、
  固定 channel、服务端模板 code 和本批成本上限，不接受手机号、消息正文、provider URL、secret
  或客户端计算的送达状态。
- `notification.delivery.capability.get`：返回 `disabled`、`software_only` 或未来经真实配置证明的
  `external`，以及渠道、模板、批量/成本上限；不返回 secret 或 provider 原始配置。
- `notification.delivery_batches.list`：有界返回最近批次的派生计数和 assurance。
- `notification.delivery_batch.get`：有界返回单批最多 50 条 delivery 状态、订单引用和安全错误码，
  供人工降级；不返回手机号、正文、HMAC 或 provider 原始响应。

冻结面由 **52 → 53 条命令、33 → 36 条查询**。三条查询和新命令都不进入 AI 投影、不允许
Edge/offline。新增 `notification_send` 仅授予 active admin；handler 仍同时复核
`customer_read`。

新命令基础风险为 R3：1–10 个收件目标需要所见即所得确认；11–50 个由参数阈值升级到 R4，沿用
另一位 active admin 的同步 step-up。50 是硬上限，不拆批绕过。确认引用冻结订单集合、筛选、
模板、channel、provider assurance、成本上限和服务端生成的确认摘要，续跑只提交 `confirm_ref`。
同一首跳 idempotency key 重放只返回原卡冻结的 authority 与摘要，不重新读取候选、模板或当前
provider 配置；冻结事实已漂移时二跳失败关闭，必须重新发起确认。

拆批风险由 PostgreSQL 的 store-scoped advisory lock 串行计量：滚动 24 小时内已创建批次的
`recipient_count` 加尚未过期的 pending 卡预留共同构成服务端权威总量，超过 10 个目标即升级
R4。确认事务把 pending 预留原子替换成 batch，不出现额度空窗；每店同时有效和滚动 24 小时
创建的通知 pending 卡均硬限 100 张。HTTP 入口再按 session、组织和门店限制为每分钟 30 次，
先于昂贵的候选与模板查询拒绝超量请求；数据库限额仍作为绕过应用层时的最终防线。

### 3. 模板由服务端版本化，不执行任意正文

`notification_templates` 是组织级、只追加版本的服务端模板表。首期只有
`pickup_reminder_v1`，占位符固定为订单号、衣物数和欠款分值；浏览器不能上传模板正文或
provider template id。模板行保存 code、version、channel、正文和状态，不包含顾客 PII。
升级迁移为已有组织回填该版本；全新实例只在 commissioning marker 与身份资料
同一事务落库时建立，普通维护或测试组织行不会隐式产生通知配置。

入队事务按稳定顺序锁定订单，再次执行 ADR-23 候选条件，按订单生成一个 delivery。服务端冻结
模板版本、消息 SHA-256 与组织密钥 HMAC 的目标号码指纹；worker 发送前重新读取订单、重算目标
指纹和正文摘要，任一漂移都不发送并进入人工降级。

### 4. outbox 状态机、租约和 provider 幂等

新增 store-scoped 批次、delivery、attempt 和 receipt 表。delivery 状态固定为：

`queued → sending → accepted → delivered`

可恢复分支为 `sending → retry_wait → sending`；终态/人工分支为 `manual_required`、`cancelled`。
状态只能由受控 store 方法和数据库约束推进，不允许回到较早状态。

- worker 用 `SKIP LOCKED` 等价的有界 claim、30 秒租约和不可猜 lease token；并发 worker 不得取得
  同一 delivery。PostgreSQL 的 claim、续租、过期接管与结算时间只使用数据库
  `statement_timestamp()`，应用时钟不参与租约授权。
- provider 调用 10 秒超时，固定最多 5 次；瞬时故障和响应不确定按 1/5/30/120 分钟退避，用同一
  `delivery_id` 作为 provider 幂等 key。永久故障、重试耗尽和 72 小时无回执进入人工降级。
- adapter 必须声明 channel、assurance、单位成本、批次成本上限和幂等/回执能力。发送前与结算时
  都重查本批上限；金额为整数分，不能出现负数、浮点或 provider 未说明的额外费用。
- attempt/receipt 只追加保存受控结果码、耗时、整数成本和不透明引用摘要；不保存请求/响应正文、
  header、手机号、消息、token 或异常原文。
- receipt 先由具体 adapter 验签和限量解析，再归一成 delivery id、唯一 receipt id、状态和时间；
  重复回执幂等，晚到状态不得把 `delivered` 降级。software-only 测试只调用归一化端口，不开放
  公网 callback 路由。

无法只靠本地事务保证第三方 exactly-once；真实 adapter 必须证明 provider 接受稳定幂等 key，
否则响应丢失只能进入 `manual_required`，不得盲重试制造重复发送或重复计费。

### 5. 顾客隐私与并发锁序

新表不持久化手机号或消息正文。非终态 delivery 仅保留 keyed HMAC 和消息摘要；达到
`delivered`、`manual_required` 或 `cancelled` 后清除两者。订单/顾客 UUID、状态、时间、受控错误码
和费用作为受限运营证据保留，与 ADR-23 的 hash-only `notification_log` 一致。

锁序统一为 `customer/order → delivery → attempt/receipt`：

- enqueue 和 claim 都先锁订单并重查 `customer_pii_purged_at`，再创建或锁 delivery；
- 顾客匿名化若遇到尚未过期的 `sending` 租约则整次失败关闭，避免网络调用与擦除提交交叉；
- 已过期 `sending`、`queued`、`retry_wait` 在同一匿名化事务内取消并清指纹；
- 匿名化提交后，数据库 trigger 拒绝为已擦除订单新增或重新激活 delivery；
- receipt 不反向锁订单，只能追加不含 PII 的终态证据，避免形成 delivery → order 死锁。

worker 调用 provider 前后都受 lease token 和订单隐私 anchor 约束。并发回归必须覆盖 enqueue、claim、
匿名化与 receipt，不能用重试掩盖 40P01。

### 6. software-only 与真实 provider 边界

默认 capability 为 `disabled`，不会启动通知 worker。只有显式软件验收配置才加载无网络、费用为 0
的 deterministic fake adapter；它最多显示“软件模拟已接单”，不能显示真实发送/送达。

真实短信或微信 adapter 只有在以下材料齐全后才能标记 `external`：

- 独立 secret file/manager、最小权限账号和轮换方案；
- 获批模板与固定 callback origin；
- 单条/单批/单日额度和整数费用保护；
- 真实 sandbox 请求、响应丢失幂等、签名 webhook、重复/乱序回执和永久失败证据；
- 日志/审计/支持包不含 secret、手机号或 provider payload。

缺任一项时状态为 `blocked_external_provider`，人工名单继续可用。不得提交 provider secret，也不得
为方便测试关闭 webhook 验签、TLS、Host/Origin、速率、大小或重放校验。

## 验收

1. Contracts 冻结 53/36，验证严格输入、R3→R4 阈值、PII redaction、offline/AI deny。
2. `0052` apply/replay、RLS/GUC、权限、不可变 attempt/receipt、状态/费用 CHECK 与匿名化触发器通过。
3. memory 与真实 PostgreSQL 覆盖入队再校验、并发 claim、响应丢失同 key、退避/耗尽、回执乱序、
   成本上限、跨租户和隐私并发。
4. Web 明确区分 disabled/software-only/external，模拟模式不用“已发送/送达”；永久失败可回到人工名单。
5. Cloud API/Browser 只使用合成号码和 fake adapter；证据标记 `software_only`。
6. 最终 workspace、fresh PostgreSQL、Browser、独立安全/数据库复核与精确资源清理全绿。

## 后果

- 本片提供可替换的发送内核和人工降级，不提供真实短信/微信完成声明。
- 现有催取候选和人工 CSV 仍是 provider 被阻塞时的完整安全路径。
- 后续 provider PR 不能改变业务状态机，只能实现 adapter、secret/config 和受控 webhook route，并
  提交独立外部证据。
- 通知不会离线发送，也不会由 AI、普通 automation 或 Edge replay 发起。

## 否决的备选

- **把手机号/消息正文直接存 outbox**：扩大 ADR-42 持久 PII 清理面，否决。
- **fake 自动标 delivered**：会制造虚假送达证据，否决。
- **响应超时就换新请求 id 重发**：可能重复发送/计费，否决。
- **任意模板正文或 provider URL 由浏览器提交**：引入注入、钓鱼与 SSRF 面，否决。
- **匿名化时跳过锁中的 delivery**：会在擦除后继续发送或留副本，否决。
- **有 SDK 单测就标真实接入**：不能证明账号、模板、网络、费用和 webhook，否决。
