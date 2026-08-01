# ADR-20：真实订单打印使用权威快照、一次性派发与设备回执

- 日期：2026-08-01
- 状态：**Accepted**
- 决策者：manpengan
- 路线：[ADR-16：边缘运营范围与契约面门禁](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 前序：[ADR-01：Web-first + Local Edge Agent](2026-07-19-adr-01-web-first-edge-agent.md)
- 影响：打印命令输入、Edge 签名协议、`print_jobs`、macOS CUPS 执行链

## 背景

当前仓库已经分别有 PostgreSQL 打印队列、服务端 capability ticket、Edge 设备回执、
ESC/POS 字节构造和 macOS CUPS 提交，但它们没有组成一条生产链：服务端 Worker 会把模拟
文本写进容器内 spool 并直接把任务标成 `done`；Edge 的签名 executor 只在单元测试里使用，
且未传模板时会打印带宏发店名、虚构手机号和顾客的演示票。

这既不能证明打印内容来自真实订单，也不能回答 `lp` 超时后究竟有没有进入 CUPS。进程若
把超时任务重新领取，可能物理打印两次；客户端若能同时提交 `order_id` 和 `ticket_no`，还
可以把一张合法订单绑定到伪造票号。

## 决策

### 1. 服务端是票号与打印快照的唯一权威

`print.ticket.enqueue` 只提交订单与打印种类，不再信任客户端票号。服务端在门店 RLS 与
事务内读取真实订单、订单行、付款和门店信息，生成严格、版本化、不可变的打印快照；
`ticket_no` 必须来自订单记录。retry/reprint 只引用原任务，由服务端复制其订单与种类并
重新读取当前允许的权威信息；不得复制可能已经被业务订正或隐私清除的历史快照。

快照使用 canonical JSON 计算 SHA-256。数据库同时保存带版本字段的快照、摘要和打印机种类；
Edge 不能替换字段、追加演示内容或从本地 UI 重建业务事实。生产路径删除任何默认演示票，
缺快照即失败关闭。

姓名、手机号与订单备注属于顾客隐私数据面。隐私导出必须连同关联打印快照一起导出；存在
`queued/printing` 快照时禁止宣称匿名化成功。关联任务全部进入终态后，匿名化事务清空快照
JSON 与订单备注，保留原 SHA-256、capability 和设备回执作为不含直接 PII 的审计证据；清空
是单向状态，不得恢复历史快照。后续 retry/reprint 仍从已经隐私清除的当前订单权威重新生成。

### 2. 派发只走已认证的主进程通道

服务端在一个 PostgreSQL 事务里把最老的 `queued` 任务原子变为 `printing`，绑定当前已配对
设备、随机一次性 nonce、打印快照摘要和派发时间，并签发短时 Ed25519 capability ticket。
ticket 至少签入 `job_id / staff_id / device_id / origin / nonce / printer_kind /
snapshot_sha256 / issued_at / exp`。

claim 与 receipt 是 Edge 主进程专用传输，不注册为浏览器业务命令，也不暴露给 preload 或
renderer。设备与租户来自认证会话和配对记录，任何客户端头或请求体都不能覆盖。

### 3. `printing` 不因超时自动重新领取

打印状态扩展为 `queued → printing → done | failed | uncertain`。`printing` 表示 capability
已经交给设备；此后即使进程崩溃、HTTP 超时或 CUPS 结果不明，服务端也不得按租约到期自动
把同一任务重新派发。无法证明“肯定未提交”时进入 `uncertain`。

操作员确认后只能用 retry/reprint 创建新的 job、nonce 与 capability，原任务和回执保持
不可变。这样会把“可能漏打一张”暴露给人处理，而不是静默制造重复实体小票。

### 4. Edge 先持久化，再提交 CUPS raw

Edge 验证服务端签名、设备和 origin audience、job/printer/snapshot 精确绑定，并以请求发起
时的单调时钟锚定本地截止；墙钟、重启、休眠或连续性不明不能延长 ticket。执行前先把
nonce、快照摘要和 `dispatching` 状态原子写入私有持久账本并 `fsync`，再从服务端快照渲染
ESC/POS 字节，经已发现且显式允许的 CUPS queue 使用固定 `lp -o raw` 参数提交。

`lp` 成功仅表示 CUPS 接受并返回可追踪 job id，不表示纸已走完。提交前确定失败可回
`failed`；提交调用超时、输出不可解析或崩溃恢复进入 `uncertain`，不得自动再次调用 `lp`。
同一物理端口串行执行。

### 5. 设备签名回执由 PostgreSQL 幂等结算

设备私钥签名回执至少绑定 `job_id / ticket_nonce / snapshot_sha256 / result /
cups_job_id / per_device_receipt_seq / at`。服务端以数据库中的配对公钥验签，在同一事务里锁
设备回执高水位和任务，重校验 device、nonce、snapshot 与当前 `printing` 绑定，写不可变
回执与审计并结算终态。

完全相同回执重送返回已存结果；同序号不同摘要、同 nonce 不同结果或跨任务挪用一律拒绝。
业务事务失败时任务、回执、高水位和审计一起回滚。

### 6. 离线边界不伪造最终票号

普通 offline grant 可以排队 `print.ticket.enqueue/retry/reprint`，但只有这些命令完成服务端
权威重放并产生真实 job/快照后，才可取得新 capability 并打印。已经取得且仍能证明单调
截止连续性的派发可在短暂断网中继续执行；Edge 不从离线草稿自行编票号或最终金额。

### 7. 软件链与实体证据分层

自动化最低覆盖真实 PostgreSQL → 签名派发 → Edge 验签/ESC/POS → 可控假 CUPS → 设备签名
回执 → PostgreSQL 终态，并覆盖篡改、重复、崩溃与 uncertain。macOS 上存在真实 CUPS queue
只能证明系统提交；XP-58 的中文、金额、条码、走纸、切刀和补打仍是独立实体门禁。

## 后果

- 未新增业务命令或查询名，`m2-freeze.test.ts` 清单不变；主进程专用 Edge 协议与签名形状
  发生变化，由本 ADR 满足 ADR-16 的契约面门禁。
- 旧模拟 spool 只保留显式测试/诊断入口，不再作为生产自动 Worker；历史模拟产物不再被
  当作真实打印完成证据。
- `done` 的含义收紧为“CUPS 已接受且服务端收到匹配设备回执”，仍不等价于实体出纸验收。
- 旧 capability/receipt 不补猜 snapshot 或 CUPS 绑定，只能进入恢复/人工处理。

## 否决的备选

- **继续由客户端提交 ticket_no**：形成两个业务权威，否决。
- **把服务端模拟 spool 标为真实完成**：没有设备或 CUPS 证据，否决。
- **printing 租约过期自动重领**：可能重复出纸，否决。
- **`lp` 退出 0 即宣称实体打印成功**：只能证明 CUPS 接受，否决。
- **Edge 用默认演示票补缺字段**：会把虚构顾客/金额印到生产票据，否决。
