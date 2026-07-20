# M0-1 RLS 三元租户隔离与性能 spike

本目录验证 ADR-02 的数据库兜底与性能假设，不包含生产代码。测试使用虚构的 2 个 org × 2 个 store，生成 100,000 张订单及各 100,000 条订单行、衣物记录。

## 环境

- 宿主：macOS 26.5.2，Apple M4 Pro（14 核，48 GiB）
- Docker Desktop：client/server 29.3.1
- 容器：PostgreSQL 16.14（`postgres:16-alpine`，aarch64）
- 依赖：Docker daemon、Docker Compose、Bash

## 一键复现

```bash
cd tools/spikes/m0-1-rls
export RLS_DB_PASSWORD="$(openssl rand -hex 24)"
export RLS_APP_PASSWORD="$(openssl rand -hex 24)"
bash scripts/run.sh
```

脚本只销毁 Compose project `laundry-m0-1-rls` 自己的容器/匿名数据卷，然后依次执行建表、RLS 策略、造数、负向测试和 RLS on/off 压测。若宿主端口 `55431` 被占用，可额外设置 `RLS_DB_PORT`。

清理：

```bash
docker compose down -v --remove-orphans
unset RLS_DB_PASSWORD RLS_APP_PASSWORD RLS_DB_PORT
```

## 验证内容

- 三表均由 `laundry_owner` 持有，`ENABLE` + `FORCE ROW LEVEL SECURITY`；业务连接是 `laundry_app`，且 `NOBYPASSRLS`。
- [policy-templates.sql](sql/policy-templates.sql) 给出 org/store 两种 `USING` + `WITH CHECK` 模板，三张店级表实际应用 store 模板；条件仅比较本行字段与事务 GUC。
- [acceptance.sql](sql/acceptance.sql) 与 [worker-missing.sql](sql/worker-missing.sql) 覆盖 GUC 未设置、空值、回滚残留、同连接池串租户、worker 漏注入的读写两侧。
- 组合外键拒绝同 org 跨 store 挂靠，以及同 store 跨 order 挂接 `order_line`。
- 三条查询各运行 250 次。结果是 PostgreSQL 进程内、预热缓存后的查询执行耗时，不代表网络端到端延迟。RLS off 对照在同一结构、同一事务内临时关闭 RLS，查询阶段仍 `SET LOCAL ROLE laundry_app`，事务提交前恢复 RLS。

## 本机结果

| 查询           | RLS on P50/P95/P99 (ms) | RLS off P50/P95/P99 (ms) | P95 差值 (ms) |
| -------------- | ----------------------: | -----------------------: | ------------: |
| 单店当日单列表 |   0.015 / 0.019 / 0.030 |    0.013 / 0.016 / 0.024 |        +0.003 |
| 按状态过滤     |   0.015 / 0.019 / 0.033 |    0.013 / 0.018 / 0.025 |        +0.001 |
| 按客户查单     |   0.017 / 0.022 / 0.036 |    0.015 / 0.018 / 0.030 |        +0.004 |

三条 RLS on P95 均低于 50ms，`EXPLAIN (ANALYZE, BUFFERS)` 分别命中 `orders_store_created_idx`、`orders_store_status_created_idx`、`orders_store_customer_created_idx`，无 Seq Scan。

原始证据：

- [isolation-and-fk.txt](evidence/isolation-and-fk.txt)：五类旁路、WITH CHECK、组合外键、应用角色
- [benchmark-rls-on.txt](evidence/benchmark-rls-on.txt) / [benchmark-rls-off.txt](evidence/benchmark-rls-off.txt)：分位数与三份 EXPLAIN
- [schema-introspection.txt](evidence/schema-introspection.txt)：owner、FORCE RLS、NOBYPASSRLS
- [postgres-version.txt](evidence/postgres-version.txt)：数据库版本
- [source-hashes.txt](evidence/source-hashes.txt)：生成证据时的 spike 脚本与 SQL Git blob 哈希

## 实现提示

`NULLIF(current_setting(..., true), '')::uuid` 让未设置和空 GUC 都产生 `NULL` 比较：读侧正常返回 0 行，写侧触发 RLS 违例。非空但格式错误的 GUC 会报 UUID 转换错误，仍然 fail-closed；M1 必须只从已校验的服务端会话注入 UUID，并保持每事务 `SET LOCAL`。
