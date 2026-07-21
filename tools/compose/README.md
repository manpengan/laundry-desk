# Laundry-V2 全队统一本地 Docker Compose 开发底座

本模块为 Laundry-V2 全队本地开发的正式统一部署底座（从 M0-6 转正），集成了 PostgreSQL 16 数据库、Mock Edge 本地微服务网关及 Mock Cloud 中央 Agent 控制台容器，全队开发与集成测试统一切至本目录。

## 1. 平台清单与前置依赖

### 平台兼容清单

- **macOS**：macOS 13+ (Apple Silicon / Intel)
- **Linux**：Ubuntu 22.04 LTS+, Debian 12+, RHEL 9+ (x86_64 / arm64)
- **Windows**：Windows 10/11 (需通过 WSL2 + Docker Desktop / OrbStack 运行)

### 前置软件依赖

- **Docker Engine**：`>= 24.0.0`
- **Docker Compose**：`>= v2.20.0` (推荐 CLI 插件模式 `docker compose`)
- **可选**：主机 `psql` 客户端（无主机 psql 时，迁移 / RLS 冒烟脚本会回退到 `docker exec`）

## 2. 暴露端口与服务清单

| 服务名称              | 内部端口 | 暴露端口 | 架构角色与作用                   | 健康检查接口                       |
| :-------------------- | :------- | :------- | :------------------------------- | :--------------------------------- |
| **postgres**          | 5432     | `8543`   | PostgreSQL 16 物理隔离数据库底座 | `pg_isready -U postgres`           |
| **mock-edge-server**  | 3000     | `8080`   | Edge 本地终端微服务网关占位      | `GET http://localhost:8080/health` |
| **mock-cloud-server** | 3001     | `8081`   | 中央云端 Agent / API 控制台占位  | `GET http://localhost:8081/health` |

## 3. 凭据清单 (弱凭据本地开发专用)

> [!WARNING]
> 以下凭据及密码仅适用于本地开发 (`# 仅限本地 / LOCAL ONLY`)，严禁部署到任何生产或公网测试环境！

- **Postgres 超级管理员**：
  - 用户名：`postgres`
  - 密码：`postgres_secure_password` (`# 仅限本地 / LOCAL ONLY`)
- **应用连接角色 (Drizzle/Mock Edge 连接用)**：
  - 用户名：`laundry_app`
  - 密码：`app_secure_password` (`# 仅限本地 / LOCAL ONLY`)
  - 属性：`NOBYPASSRLS` (物理强限制，绝对不允许绕过行级隔离规则)
- **迁移连接角色 (Migrator 用)**：
  - 用户名：`laundry_owner`
  - 密码：`owner_secure_password` (`# 仅限本地 / LOCAL ONLY`)
  - 补充说明：`init.sql` spike 路径下为 `LOGIN` 以便本地连接；正式 `packages/db` 的 `0001_roles.sql` 会将 `laundry_owner` 收紧为 `NOLOGIN`（与 ADR-02 一致）。`migrate-v2.sh` 在同一次会话内应用全部迁移，并在 owner 不可登录时回退到 `postgres` + `SET ROLE laundry_owner`。

## 4. 两条 Schema 路径：spike `init.sql` vs 正式 `packages/db`

|              | **Spike 路径（M0-6，旧）**                                     | **正式 v2 路径（M1+）**                                            |
| :----------- | :------------------------------------------------------------- | :----------------------------------------------------------------- |
| **入口**     | `docker-compose.yml` 挂载 `init.sql` → 首启自动执行            | `./tools/compose/migrate-v2.sh`                                    |
| **SQL 真源** | `tools/compose/init.sql`                                       | `packages/db/src/migrations/0001_*.sql` … `0003_*.sql`             |
| **表**       | 演示用 `orders` / `order_lines` / `garments`（文本租户键）     | 正式 identity/platform + A5 session（UUID、expand-only）           |
| **RLS GUC**  | `app.org_id` / `app.store_id`（文本比较）                      | 同名 GUC，但谓词为 `NULLIF(... , '')::uuid`（A3 冻结模板）         |
| **冒烟**     | `./tools/compose/smoke-test.sh`（HTTP 假开单 + spike 四元 FK） | `./tools/compose/smoke-rls.sh`（`laundry_app` + `SET LOCAL` 隔离） |
| **CI**       | 不进 CI（本地 Docker）                                         | 不进 CI；静态顺序/破坏性检查见 `packages/db/test/*`                |

两者可共存于同一 Postgres 卷（spike 演示表 + 正式 M1 表），但**语义不同**：不要用 spike 文本租户键去测正式 UUID RLS，也不要把 `init.sql` 当作生产 schema。

正式迁移顺序（`ON_ERROR_STOP`，禁止跳步）：

1. `0001_roles.sql` — `laundry_owner` / `laundry_app`（ADR-02）
2. `0002_m1_identity_platform.sql` — orgs / stores / staffs / … / pin_challenges
3. `0003_rls_and_grants.sql` — ENABLE+FORCE RLS、A3 策略、app grants

详见 [`packages/db/src/migrations/README.md`](../../packages/db/src/migrations/README.md)。

## 5. 正式 v2：迁移与 RLS 冒烟（本地）

```bash
# 1) 拉起 Postgres（可只起库；全栈亦可）
cd tools/compose
docker compose up -d postgres
# 等待 healthy 后：

# 2) 应用 packages/db 正式迁移（laundry_owner URL，可用环境变量覆盖）
./migrate-v2.sh

# 可选覆盖（默认已指向本 compose）：
# export LAUNDRY_OWNER_DATABASE_URL='postgresql://laundry_owner:owner_secure_password@127.0.0.1:8543/laundry_v2'
# export SUPERUSER_DATABASE_URL='postgresql://postgres:postgres_secure_password@127.0.0.1:8543/laundry_v2'

# 3) 正式表 RLS 隔离冒烟（laundry_app + SET LOCAL GUC）
./smoke-rls.sh
```

从仓库根目录：

```bash
./tools/compose/migrate-v2.sh
./tools/compose/smoke-rls.sh
```

**重置**：`docker compose down -v` 清空卷后，`init.sql` 会再次以 spike 方式初始化角色；再跑 `migrate-v2.sh` 叠正式 schema。

## 6. 冷启动与性能实测

- **全流程冷启动拉起耗时**：**39 秒**（包含干净镜像 Build、Node 依赖安装、Postgres 启动建表、双微服务健康检测就绪及全套冒烟断言执行完毕）。
- **Postgres 单容器就绪**：约 **2-3 秒**。

## 7. M0-1 架构与 RLS 隔离规范复用声明

> **M0-1 复用声明**：本模块中的 PostgreSQL 多租户 Schema 设计与 Row Level Security (RLS) 策略完全继承并遵循 Codex 在 M0-1 Spike 中确立的架构规范。
>
> - 在事务内通过 `SET LOCAL app.org_id` / `SET LOCAL app.store_id` 进行会话变量绑定。
> - 未设置变量时默认物理阻断返回 0 行 (Default-closed)。
> - Spike 表配合 `(org_id, store_id, order_id, id)` 四元主键与外键约束，物理阻止同店跨订单挂衣服。
> - 正式 M1 表使用 A3 UUID 谓词模板（见 `0003_rls_and_grants.sql`），由 `smoke-rls.sh` 校验。

## 8. Spike 一键启动与冒烟测试（HTTP / 演示订单表）

在项目根目录下执行以下命令：

```bash
./tools/compose/smoke-test.sh
```

该脚本会 `down -v` 重建容器拓扑，走 mock Edge **假开单 → 打印 → 取衣** 与 spike 表 RLS/四元 FK 断言。**不**替代正式 `migrate-v2.sh` / `smoke-rls.sh`。
