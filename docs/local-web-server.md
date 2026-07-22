# 本地 Web Server 联调（M1）

两条路径：

| 模式 | 启动 | 依赖 |
| --- | --- | --- |
| **memory（默认）** | `pnpm local:server` | 无 Postgres |
| **pg** | `pnpm local:server:pg` 或 `LAUNDRY_USE_LOCAL_PG=1` / `DATABASE_URL=…` | compose Postgres + `migrate-v2.sh` |

## 终端 A — API

```bash
# 内存 identity
pnpm local:server
# http://127.0.0.1:8787  mode local-memory

# 真 PG（需先起库并 migrate）
cd tools/compose && docker compose up -d postgres && cd ../..
./tools/compose/migrate-v2.sh
pnpm local:server:pg
# /health → mode: local-pg
```

Demo（**LOCAL ONLY**）：

| 字段       | 值                           |
| ---------- | ---------------------------- |
| org_code   | `hongfa`                     |
| store_code | `main`                       |
| username   | `admin` / `staff` / `staffb` |
| password   | `demo`                       |
| PIN        | `1234`                       |

探针：

```bash
curl -s http://127.0.0.1:8787/health | jq .

curl -s -c /tmp/ld.txt -X POST http://127.0.0.1:8787/api/v2/auth/login \
  -H 'content-type: application/json' \
  -d '{"org_code":"hongfa","store_code":"main","username":"admin","password":"demo","device_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}' | jq .

# PIN 快切：cookie 名 laundry_csrf / laundry_refresh，头 x-csrf-token
```

## 终端 B — Web

```bash
pnpm local:web
# http://127.0.0.1:5173
```

默认 `VITE_API_BASE_URL=http://127.0.0.1:8787`（见 `apps/web/host/main.tsx`）。

## 实现位置

| 路径 | 作用 |
| --- | --- |
| `apps/server/src/http/*` | Fastify app + main entry |
| `apps/server/src/local/create-runtime.ts` | memory / PG runtime 选择 |
| `apps/server/src/local/pg-seed.ts` | 正式表 demo 种子（幂等） |
| `apps/server/src/identity/pg-store.ts` | identity 仓储 PG 适配 |
| `apps/server/src/identity/memory-store.ts` | 内存仓储（测试默认） |
| `apps/web/src/auth/HttpAuthClient.ts` | 浏览器 AuthClient |

### PG 环境变量

| 变量 | 含义 |
| --- | --- |
| `DATABASE_URL` | 主连接串（建议 superuser / admin 做 identity 本地联调） |
| `DATABASE_ADMIN_URL` / `SUPERUSER_DATABASE_URL` | 备选 admin |
| `LAUNDRY_USE_LOCAL_PG=1` | 使用 compose 默认 admin URL `127.0.0.1:8543/laundry_v2` |

默认 admin URL（**LOCAL ONLY**）：

`postgresql://postgres:postgres_secure_password@127.0.0.1:8543/laundry_v2`

说明：本地 identity 读写走 admin 连接，避免 FORCE RLS 下未设 GUC 的 refresh hash 查找为 0 行。生产路径应改为 `laundry_app` + 事务级 `SET LOCAL` GUC +（必要时）SECURITY DEFINER 查找函数。

## 测试

```bash
# 内存 inject（无 Docker）
pnpm --filter @laundry/server test

# 仅 PG identity（需 compose + migrate）
LAUNDRY_USE_LOCAL_PG=1 node --test apps/server/dist/identity/pg-store.test.js

pnpm --filter @laundry/web test
```

## 后续

- `laundry_app` + 事务 GUC 全路径（登录 bootstrap / refresh hash）
- cookie 名 / CSRF 与 contracts 描述符严格对齐
- 生产 Argon2id 替换 scrypt
- pin_lockouts 落表
