# ADR-19：普通 offline grant 使用独立序号与 PostgreSQL 权威重放

- 日期：2026-08-01
- 状态：**Accepted**
- 决策者：manpengan
- 路线：[ADR-16：边缘运营范围与契约面门禁](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 前序：[ADR-04：离线一致性](2026-07-19-adr-04-offline-consistency.md)
- 影响：Edge queue envelope v3、offline grant 签发、PostgreSQL replay authority

## 背景

ADR-04 已把离线命令分成普通 `grant`、`primary_lease` 与 `denied` 三档，contracts 也已
冻结对应 metadata。但当前生产链只真正接通 Primary：Edge 只有拿到 lease 才建立写 authority，
所有队列项都带 `per_lease_seq`；服务端 replay 也无条件联查当前 Primary epoch。

这会产生两个问题：普通收件、顾客维护和打印排队在断网时不可用；为了让它们可用而复用
Primary，又会把不需要全店单写者的动作错误绑定到 60 秒租约和门店 epoch。

普通 grant 不能只靠 `queue_id` 或业务 idempotency key 防重。它们可以识别完全相同的请求，
却不能在两个服务端实例同时重放时证明同一 grant 的先后顺序，也不能区分「重复」和「同一
顺序位的不同请求」。因此 grant 需要自己的持久高水位。

## 决策

### 1. Queue envelope v3 为 grant 增加独立连续序号

`authorization.kind = 'grant'` 必须同时携带 `grant_id` 与正整数 `per_grant_seq`。
`primary_lease` 继续携带 `grant_id / lease_id / primary_epoch / per_lease_seq`，两种形状严格
互斥。Edge 在写队列前先把 grant 高水位原子持久化并 `fsync`，宁可跳号进入仲裁，也不能在
崩溃或重启后复用已经发出的序号。

新写入统一使用 v3。既有 v2 Primary envelope 保持自动重放兼容；v2 grant 因没有可证明的
顺序，不补猜序号，只进入人工仲裁/只读恢复。

### 2. 普通 grant 与 Primary 是两个独立能力集合

普通 grant 精确开放六项：

- `customer.upsert`
- `order.receive`
- `order.hold`
- `print.ticket.enqueue`
- `print.ticket.retry`
- `print.ticket.reprint`

Primary lease 精确开放三项：`order.pickup`、`payment.collect`、`payment.repay`。

签名 `offline_grant.allowed_commands` 永远只包含前述六项，即使同一签发响应还带 Primary
lease，也不把三项高风险命令混进 grant。Primary 作为绑定同一有效 grant 的独立附加授权；
Edge 与服务端都按 contracts 的 `offline_mode` 再做静态白名单判断，不能由数据库数组扩大。

退款、会员储值、权限、设置、密钥、备份恢复和其他 `denied` 命令继续禁止离线。

### 3. 离线收件只允许欠款或现金

普通 grant 下的 `order.receive` 可以不带首付款，或只带 `method = 'cash'` 的首付款。
微信、支付宝与其他电子方式需要在线渠道权威，断网时不得先记成已经收款。Edge 排队前和
服务端重放前使用同一规则失败关闭；服务端仍在重放事务中执行活动价目、票号和业务约束，
因此本 ADR 不宣称断网现场已经获得最终票号或可打印最终权威小票。

### 4. PostgreSQL 在业务事务内锁独立高水位

新增 `offline_grant_replay_state(org_id, store_id, grant_id, last_seq)`；命令总线事务 guard
先锁对应 grant 高水位，再判断 queue duplicate、sequence collision/gap、当前员工/角色、
设备公钥与状态、permission version、grant 吊销和签发时间窗。业务写入、不可变 replay
记录与高水位前移必须同事务提交，业务回滚不得前移序号。

`edge_replay_records` 增 `authorization_kind` 与 grant reported/accepted sequence；grant 与
Primary 字段由数据库 CHECK 形成 tagged union。相同 queue/hash 重送幂等返回原结果；相同
queue 不同 hash、相同序号不同 queue、gap 或权威变化都返回仲裁且不落业务状态。已经接受
的仲裁项仍前移高水位，避免一条坏记录永久堵住后续队列。

合法动作的时间判据是 `enqueued_at` 落在签名 grant 的 `[issued_at, not_after]` 内。它在
窗口内排队后，即使恢复联网时 grant 已自然到期仍可重放；员工停用、角色/权限版本变化、
设备撤销、grant 显式吊销或排队时间越界才进入仲裁。

## 后果

- 没有新增命令或查询，`m2-freeze.test.ts` 清单不变；queue envelope 形状与数据库 schema
  发生变化，仍依 ADR-16 留下本裁决。
- grant 顺序与 Primary epoch 完全独立，Primary 换机/接管不会把合法普通队列误判旧 epoch。
- v3 生产者需要持久 grant sequence store；损坏、回退或密钥不可用时停止离线写，不在内存
  中从 1 重新开始。
- 真正的断网最终票号与权威打印快照由后续打印派发 ADR 处理，本 ADR 只交付安全排队与最终
  PostgreSQL 重放。

## 否决的备选

- **只用 queue id / idempotency key**：无法在双实例下证明顺序位，也无法可靠区分重复与
  冲突，否决。
- **普通命令继续借用 Primary seq**：无谓缩短可用窗口，并让普通动作受全店 epoch 接管
  影响，违背三档离线模型，否决。
- **Primary 命令并入 grant.allowed_commands**：被攻陷或错误实现的 Edge 可选择 grant
  authorization 绕过 lease，否决。
- **恢复联网时要求 grant 尚未到期**：会把授权窗口内合法完成的柜台动作仅因网络中断时间长
  而作废，否决。
- **离线接受微信/支付宝等电子方式**：无法证明渠道侧真实入账，恢复后可能形成虚假已付款，
  否决。
