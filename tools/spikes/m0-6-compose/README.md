# M0-6 Spike: 本地 Docker Compose 底座与 RLS 物理强隔离验证

本模块提供了 Laundry-V2 系统本地开发的统一部署底座，集成了 PostgreSQL 16 数据库与 Mock Edge 业务网关，实机演练了租户隔离与强外键数据完整性。

## 1. 暴露端口与服务清单

| 服务名称 | 内部端口 | 暴露端口 | 作用 | 验证接口 |
| :--- | :--- | :--- | :--- | :--- |
| **postgres** | 5432 | `8543` | PostgreSQL 16 物理隔离数据库底座 | `pg_isready -U postgres` |
| **mock-edge-server** | 3000 | `8080` | Edge 模拟网关，模拟开单、打印、取衣 | `GET /health` |

## 2. 凭据清单 (弱凭据本地开发专用)

> [!WARNING]
> 以下凭据及密码仅适用于本地开发及 Spike 验证 (LOCAL_ONLY)，严禁部署到任何生产或公网测试环境！

- **Postgres 超级管理员**：
  - 用户名：`postgres`
  - 密码：`postgres_secure_password` (*仅限本地 / LOCAL_ONLY*)
- **应用连接角色 (Drizzle/Mock Edge 连接用)**：
  - 用户名：`laundry_app`
  - 密码：`app_secure_password` (*仅限本地 / LOCAL_ONLY*)
  - 属性：`NOBYPASSRLS` (物理强限制，绝对不允许绕过行级隔离规则)
- **迁移连接角色 (Migrator 用)**：
  - 用户名：`laundry_owner`
  - 密码：`owner_secure_password` (*仅限本地 / LOCAL_ONLY*)

## 3. RLS 与四元外键数据防线

1. **三表联合隔离**：`orders`, `order_lines`, `garments` 表均被 `ALTER TABLE ... FORCE ROW LEVEL SECURITY` 锁定。
2. **会话级隔离变量**：Drizzle/Client 必须在同一个事务连接中执行 `SELECT set_config('app.org_id', $1::text, true)` 注入租户。未注入或租户错配时，Postgres 默认物理返回 0 行 (Default-closed)。
3. **四元级联约束**：
   - `order_lines` 使用主键 `(org_id, store_id, order_id, id)`。
   - `garments` 必须引用 `order_lines(org_id, store_id, order_id, id)`。
   - 这在物理 Schema 级别强力杜绝了把租户 A 订单的衣物误挂到租户 B 订单明细上的“同店跨单挂衣”漏洞。

## 4. 冷启动与性能说明

- **Postgres 容器冷启动就绪耗时**：约 2-3 秒 (Alpine 极简镜像，开机后自动扫描 `/docker-entrypoint-initdb.d/init.sql` 完成 DDL 建表和角色初始化)。
- **Mock Edge Server 编译与启动耗时**：使用 BuildKit 或传统构建器，命中缓存时 1 秒就绪；首开冷启动取决于网络 npm install 耗时 (约 20-30 秒)。
- **性能**：由于 GUC 变量绑定在连接会话内存中，RLS 过滤无需跨表 JOIN 租户元数据，单表过滤检索性能为 \(O(1)\)，极度契合高并发场景。

## 5. 冒烟测试与证据复现

在项目根目录下执行以下命令，将一键拉起环境并进行完整的往返流程检验：
```bash
./tools/spikes/m0-6-compose/smoke-test.sh
```
演练输出详情请参见 [evidence/m0-6-evidence.log](evidence/m0-6-evidence.log)。
