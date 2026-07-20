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

## 2. 暴露端口与服务清单

| 服务名称 | 内部端口 | 暴露端口 | 架构角色与作用 | 健康检查接口 |
| :--- | :--- | :--- | :--- | :--- |
| **postgres** | 5432 | `8543` | PostgreSQL 16 物理隔离数据库底座 | `pg_isready -U postgres` |
| **mock-edge-server** | 3000 | `8080` | Edge 本地终端微服务网关占位 | `GET http://localhost:8080/health` |
| **mock-cloud-server** | 3001 | `8081` | 中央云端 Agent / API 控制台占位 | `GET http://localhost:8081/health` |

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
  - 补充说明：已在 `init.sql` 中为 `laundry_owner` 补全 `maintenance_policy`，确保具备 DDL 迁移与初始化能力。

## 4. 冷启动与性能实测

- **全流程冷启动拉起耗时**：**39 秒**（包含干净镜像 Build、Node 依赖安装、Postgres 启动建表、双微服务健康检测就绪及全套冒烟断言执行完毕）。
- **Postgres 单容器就绪**：约 **2-3 秒**。

## 5. M0-1 架构与 RLS 隔离规范复用声明

> **M0-1 复用声明**：本模块中的 PostgreSQL 多租户 Schema 设计与 Row Level Security (RLS) 策略完全继承并遵循 Codex 在 M0-1 Spike 中确立的架构规范。
> - 在事务内通过 `SET LOCAL app.org_id` / `SET LOCAL app.store_id` 进行会话变量绑定。
> - 未设置变量时默认物理阻断物理返回 0 行 (Default-closed)。
> - 配合 `(org_id, store_id, order_id, id)` 四元主键与外键约束，物理阻止同店跨订单挂衣服。

## 6. 一键启动与冒烟测试

在项目根目录下执行以下命令：
```bash
./tools/compose/smoke-test.sh
```
