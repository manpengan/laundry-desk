# 通用 V2 本地 PostgreSQL + Fastify

本目录提供 V2 本地优先运行环境。日常启动、停止和重置统一从仓库根目录使用
`pnpm local:*`，不要直接拼接 Compose 命令。

## 运行边界

| 服务        | 用途                                      | 宿主地址                |
| ----------- | ----------------------------------------- | ----------------------- |
| `postgres`  | PostgreSQL 16                             | `127.0.0.1:8543`        |
| `migrate`   | 校验并执行正式 SQL migrations             | 不发布端口              |
| `bootstrap` | 显式创建通用 local 门店和首位管理员       | 不发布端口              |
| `server`    | 使用 `laundry_app` 与 RLS 的 Fastify 服务 | `http://127.0.0.1:8787` |

PostgreSQL 和 Fastify 只发布到 loopback，不对局域网开放。源码和 Compose
文件不提供数据库密码、管理员密码或 PIN。

`server` 还把仓库外配置目录的 `photos/` 挂载到
`/var/lib/laundry/photos`。照片只通过认证后的固定 HTTP 路由访问，不发布静态目录；
服务端限制 JPEG/PNG/WebP、单文件 8 MiB，并按文件数和总字节执行配额。该固定挂载点
必须是空目录或包含有效 `.laundry-photo-store-v1` 所有权标记；其他非空目录、符号链接
路径和任意环境路径都会拒绝启动。

## 首次启动

需要 Docker Desktop（或兼容的 Docker Compose runtime）、Node.js 22+ 和
pnpm 11。

首次创建管理员时，先在当前终端提供以下四个值：

```bash
: "${LAUNDRY_BOOTSTRAP_ADMIN_USERNAME:?set administrator username}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME:?set administrator display name}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD:?set administrator password}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_PIN:?set administrator PIN}"

export LAUNDRY_BOOTSTRAP_ADMIN_USERNAME
export LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME
export LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD
export LAUNDRY_BOOTSTRAP_ADMIN_PIN

pnpm local:up -- --bootstrap
```

不要把这些值写进仓库、shell 脚本或日志。`--bootstrap` 缺少任一输入都会
失败；普通启动不需要这些变量：

```bash
pnpm local:up
```

`local:up` 会依次检查 Compose、启动 PostgreSQL、执行 migrations、检查
schema/profile，并在通过后启动 Fastify。带 `--bootstrap` 时，管理员创建发生在
Fastify 启动前。

## 本地配置

首次 `local:up` 会生成互相独立的数据库和签名 secret。macOS 默认位置为：

```text
~/Library/Application Support/laundry-desk-v2/local/config.json
```

配置目录权限必须为 `0700`，配置文件必须为 `0600`；权限不正确时命令会拒绝
继续。该文件位于仓库外，不包含管理员密码或 PIN。测试和 CI 可以通过绝对路径
`LAUNDRY_LOCAL_CONFIG_DIR` 使用隔离目录，日常运行无需设置。

同目录的 `photos/` 是持久化业务数据，`local:down` 不会删除。不要把它复制进仓库；
备份时应与 PostgreSQL 数据保持同一恢复点，也不要手工删除其中的所有权标记。

`pnpm local:backup` 会先停止 Web Server，在同一静止窗口生成 PostgreSQL dump 和
私有照片快照，并用 `.bundle.json` 的 SHA-256 将二者绑定为一个恢复集；完成后恢复
Server。恢复时必须提供输出中的 `Confirm SHA-256`，工具会逐文件校验照片、先生成
完整的恢复前备份，再恢复数据库与照片：

```bash
pnpm local:restore -- --file "/absolute/path/laundry-v2-backup-....dump" \
  --confirm-sha256 "<Confirm SHA-256>"
```

恢复集目录及文件必须保持 `0700/0600`，不得拆分、重命名或手工修改。

## 验证

```bash
curl --fail http://127.0.0.1:8787/health
bash tools/compose/smoke-rls.sh
```

`migrate-v2.sh` 在 `laundry_schema_migrations` 记录文件名和 SHA-256 checksum。
重复执行是 no-op；已应用 migration 的内容发生变化时会失败。

## 停止与重置

正常停止保留 PostgreSQL 数据卷：

```bash
pnpm local:down
```

默认 project 为 `laundry-desk`，对应数据卷
`laundry-desk_pgdata-v2`。需要清空本地数据库时，只能使用精确确认串：

```bash
pnpm local:reset -- --confirm DELETE-laundry-desk-v2-local
```

reset 会先停止默认 project，打印目标名称，然后只删除
`laundry-desk_pgdata-v2`。停止前和删除前都会核对卷的 managed、project 与
实例归属标签；不匹配时会安全退出。它拒绝自定义 Compose project，也不会删除
仓库外的 `config.json`。重置后再次创建管理员，需要重新运行带 `--bootstrap`
的 `local:up`。
