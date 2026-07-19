# ADR-04: 离线一致性

- 日期：2026-07-19　状态：**Accepted**（2026-07-19 定点复核通过，批量签署）　父文档：[总 RFC](2026-07-19-v2-productization-and-ai.md)
- 详设：架构 §10、§11

## 决策

1. **离线能力由 Local Edge Agent 承载**：交易与审计暂存入 Edge 加密 SQLite 队列；浏览器 IndexedDB 仅缓存 UI/字典只读数据。无 Edge 配对的纯浏览器会话 = 在线-only。
2. 离线允许：开新单（散客，现金或记欠款）与打印 = 任何持有效 grant 的配对终端；**取衣/收款 = 仅持有效 Primary lease 的终端**；历史只读（Edge 缓存窗口）。
3. 离线禁止：**退款（R4，step-up 复核必须在线完成——三审裁决）**、储值/会员卡支付、办卡充值、设置修改、AI——org 级共享状态防双花；UI 明确提示替代路径。
4. 票号：`ticket_no_blocks` 每设备预取号段，离线取号不冲突；用尽降级提示。
5. **恢复流程**：重连 → 员工重新鉴权 → 队列按序回放（幂等键去重）→ server 逐条重校验 **RBAC + 实体版本 + 业务状态** → 不符进入冲突仲裁队列 → 审计补齐 → 向店员出同步报告。
6. 离线动作凭**服务端预签发的 offline grant**（短时、设备绑定、含权限版本号与命令白名单）授权并全量入队，恢复后 server 以**当前权限**重校验、复核补签；复核失败告警进仲裁。
7. **Primary lease（终审修订：含可信时间契约）**：普通 offline grant 与高危 **Primary lease 分离**；lease 为服务端**签名对象** `{lease_id, store, device, primary_epoch, issued_at, ttl_ms, max_clock_skew_ms}`，**同店同时至多一个有效**——新 lease 在旧设备**签名 release ACK** 后即时生效；无 ACK 时须等旧 lease 到期**并越过 `max_clock_skew_ms` 容差**才生效（epoch 递增），等待期内新设备仅可在线操作。**签发串行化（diff 复核补丁）**：签发/release ACK/晋升同一事务——先对预创建的 `primary_lease_heads(org_id, store_id)`（PK 即此二元）行 `SELECT ... FOR UPDATE`，重校验旧 lease，再递增 epoch、插入 lease（`UNIQUE(org_id, store_id, primary_epoch)`）、更新 head，提交后才返回签名 lease；并发晋升在行锁排队，不可能各签一张。**Edge 禁止用墙钟（`Date.now()`）判定 lease 有效性**，公式固定：`server_not_after = issued_at + ttl_ms`（入签名）；`local_deadline = request_start_mono + ttl_ms − safety_margin_ms`（锚点取**发起请求前**时刻，绝不用响应到达时刻）；硬约束 Edge 本地授权恒不晚于 `not_after`，RTT ≥ TTL 直接 fail-closed。进程重启、OS 重启、休眠恢复、时钟异常跳变而无法证明时间连续性时，**lease 立即失效（fail-closed）**，取衣/收款降级为 online-only。每条离线高危命令绑定 `lease_id + primary_epoch + per_lease_seq`——**职责限于幂等、防重放、顺序与审计归属**：旧 epoch 回执仍写入不可变审计，拒绝自动应用领域状态、转人工仲裁；**epoch/seq 不防止物理双交付**，防物理双交付依赖签发串行化 + 不重叠 lease + 可信本地截止。旧 Primary 离线收不到吊销无妨：**权力随可信 lease 到期自动终结**。"解绑即擦除"修正为**服务端吊销原子、本地擦除 best-effort**。理由：两台离线终端同时交付同一件衣物，冲突队列无法追回实物——必须在业务规则层杜绝。
8. 前端常驻连接状态条（在线/离线/N 笔待同步）。

## 理由

断网即瘫是竞品被验证的红线（CleanCloud 差评），但把交易队列放浏览器等于把敏感状态放在不可控存储且无法保证回放完整性（二审 P0）。Edge 承载 + server 复核，把"离线信任"限制在已配对设备与已认证员工的交集内。

## 否决的备选

- 浏览器 IndexedDB 离线队列（draft1 方案，二审否决）。
- 全量离线数据库 + CRDT 同步（复杂度对收银场景过度）。
- 完全不支持离线（体验红线）。

## 后果

- 冲突仲裁队列与 Primary 晋升流程均为 M2 交付物（含 UI）；离线演练进 UI 验收门禁（拔网线开单→打印→恢复→报告正确）。
- 队列加密：随机 DB DEK + OS 凭据区 KEK 包装（**不从设备签名私钥派生**——一轮版本的此句为错误设计，已废弃）；设备解绑 = **服务端吊销原子、本地擦除 best-effort**（在线设备即刻擦除 DEK/缓存/模板并作废号段；离线设备由 lease/grant 短时效兜底，重连即强制擦除）。
- M0 演练矩阵（终审新增 + diff 复核扩充）：时钟回拨、前跳、进程重启、OS 重启、休眠跨期、旧主失联六类场景必须全绿（lease fail-closed 行为验证）；另加**双 owner 并发晋升、释放与晋升并发**（行锁串行化验证）与**长 RTT/服务端延迟**（local_deadline 恒 ≤ not_after，RTT ≥ TTL 拒启用）。
