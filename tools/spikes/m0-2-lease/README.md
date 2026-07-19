# M0-2 Primary lease 时序与可信时间 spike

本目录验证 ADR-04 的三项安全地基：head 行锁串行签发、不重叠 lease、请求发起前锚定的单调时钟截止。代码仅用于 spike，不并入生产依赖。

## 环境

- 宿主：macOS 26.5.2，Apple M4 Pro（14 核，48 GiB）
- Docker Desktop：client/server 29.3.1
- 容器：PostgreSQL 16.14（`postgres:16-alpine`，aarch64）
- Node.js 25.8.2；`pg` 8.22.0（精确锁文件）

## 一键复现

```bash
cd tools/spikes/m0-2-lease
npm ci
export LEASE_DB_PASSWORD="$(openssl rand -hex 24)"
export LEASE_APP_PASSWORD="$(openssl rand -hex 24)"
bash scripts/run.sh
```

若宿主端口 `55432` 被占用，可设置 `LEASE_DB_PORT`。脚本只清理 Compose project `laundry-m0-2-lease` 自己的资源。

清理：

```bash
docker compose down -v --remove-orphans
unset LEASE_DB_PASSWORD LEASE_APP_PASSWORD LEASE_DB_PORT \
  LEASE_DATABASE_URL LEASE_ADMIN_DATABASE_URL
```

## 设计与验证点

- [schema.sql](sql/schema.sql) 建立预创建 head、`UNIQUE(org_id, store_id, primary_epoch)` lease 表、每 lease 回放高水位及应用角色只能追加/查询的审计表。
- [lease-service.mjs](src/lease-service.mjs) 在一个事务中执行 `SELECT ... FOR UPDATE`、旧 lease 重校验、epoch++、INSERT、head UPDATE；`withTransaction` 只在 COMMIT 成功后返回签名对象。
- 默认可信时间来自 PostgreSQL `clock_timestamp()`；自动化场景注入 fake trusted clock，避免用宿主墙钟控制测试。
- 签名对象覆盖 `lease_id/store_id/device_id/primary_epoch/issued_at/ttl_ms/max_clock_skew_ms/not_after`；版本化域 `laundry.primary-lease.v1` 与固定字段顺序有 golden message 测试。`not_after = issued_at + ttl_ms` 有数据库 CHECK 与 Edge 侧双重校验，Edge 启用前强制验签。
- Edge 截止固定为 `request_start_mono + ttl_ms - safety_margin_ms`。请求发出前与响应到达时分别采集 monotonic + boot/process/wake/wall 快照；请求途中连续性丢失也拒绝启用。墙钟只用于发现不可证明的时间跳变，不参与到期计算；有效性路径无 `Date.now()`。
- 连续性字段缺失/非有限数、墙钟跳变、boot/process/wake token 变化都会永久熔断当前 session，之后只能 online-only。
- 旧 epoch 回放与 head 晋升共用行锁：按 `per_lease_seq` 严格顺序；精确重复须同时匹配 epoch 与命令名并幂等返回既有判定，同 seq 内容碰撞转 `sequence-collision` 仲裁。旧 epoch、乱序或已 release 的 lease 只写审计并转仲裁，不调用领域写入回调。
- release ACK 验签所用设备公钥解析器必须同步（内存或事务内已取值），禁止在持有 head 锁时等待外部 I/O。

## 本机结果

- Node test：32/32 通过。
- 双 owner 并发：两个 PG backend PID 同时请求，恰一张 lease 被签发。
- release ACK 与晋升并发：有效 lease 数量 ≤1；顺序 release ACK 可立即签发 epoch+1。
- 无 ACK：旧 `not_after=00:00:00.100Z`、skew=10ms；`00:00:00.109Z` 返回 online-only，`00:00:00.110Z` 才签发新 lease。
- 六类时间场景（回拨、前跳、进程重启、OS 重启、休眠恢复、旧主失联）全部降级 online-only。
- RTT=TTL 拒绝启用；RTT=85ms、TTL=100ms、margin=10ms 时本地 deadline=90ms，不延长服务端权力窗口。
- 人工制造唯一 epoch 冲突后，INSERT/head UPDATE 整事务回滚，无第二行或 head 脏写。

原始证据：

- [test-suite.txt](evidence/test-suite.txt)：32 项自动化断言
- [scenarios.jsonl](evidence/scenarios.jsonl)：逐场景期望/实际/判定、fake clock 值、backend PID、签名 lease JSON 样例
- [date-now-static-check.txt](evidence/date-now-static-check.txt)：`Date.now()` 静态检查
- [critical-path-static-check.txt](evidence/critical-path-static-check.txt)：行锁、单调截止、PG 可信时间代码位置
- [postgres-version.txt](evidence/postgres-version.txt)：数据库版本
- [security-introspection.txt](evidence/security-introspection.txt)：应用角色 NOBYPASSRLS 与审计表仅 SELECT/INSERT 权限
- [source-hashes.txt](evidence/source-hashes.txt)：生成证据时的 spike 源码、测试、脚本与 DDL Git blob 哈希

## 实现提示

fake clock 仅是验证接缝；未注入时必须回落到 PG 可信时间。M1/M2 落地时，Edge 的 boot/process/wake continuity token 需要绑定真实平台信号；无法证明连续性时直接丢弃 lease，不能尝试用墙钟“补算”剩余 TTL。
