# 本地 Web Server 联调（M1）

两条路径：

| 模式               | 启动                                                                  | 依赖                               |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------- |
| **memory（默认）** | `pnpm local:server`                                                   | 无 Postgres                        |
| **pg**             | `pnpm local:server:pg` 或 `LAUNDRY_USE_LOCAL_PG=1` / `DATABASE_URL=…` | compose Postgres + `migrate-v2.sh` |

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

本地 host **预填** demo 账号（仅 Vite host，不进库默认值）：hongfa / main / admin / demo。  
登录后顶栏应显示 **宏发·总店** / **店长**，可点 **切换员工** 用 PIN `1234` 切到店员甲。

### SPA 走查（Playwright，opt-in）

先起 API + Web，再：

```bash
# 需已安装 chromium：pnpm exec playwright install chromium
# 先起 local:server(:pg) + local:web
pnpm local:web:e2e
```

## 实现位置

| 路径                                       | 作用                     |
| ------------------------------------------ | ------------------------ |
| `apps/server/src/http/*`                   | Fastify app + main entry |
| `apps/server/src/local/create-runtime.ts`  | memory / PG runtime 选择 |
| `apps/server/src/local/pg-seed.ts`         | 正式表 demo 种子（幂等） |
| `apps/server/src/identity/pg-store.ts`     | identity 仓储 PG 适配    |
| `apps/server/src/identity/memory-store.ts` | 内存仓储（测试默认）     |
| `apps/web/src/auth/HttpAuthClient.ts`      | 浏览器 AuthClient        |

### PG 环境变量

| 变量                                            | 含义                   |
| ----------------------------------------------- | ---------------------- |
| `LAUNDRY_USE_LOCAL_PG=1`                        | 启用 compose 双连接    |
| `DATABASE_URL` / `LAUNDRY_PG_APP_URL`           | runtime：`laundry_app` |
| `DATABASE_ADMIN_URL` / `SUPERUSER_DATABASE_URL` | seed superuser         |

默认（**LOCAL ONLY**）：

| 角色  | URL                                                                        |
| ----- | -------------------------------------------------------------------------- |
| app   | `postgresql://laundry_app:app_secure_password@127.0.0.1:8543/laundry_v2`   |
| admin | `postgresql://postgres:postgres_secure_password@127.0.0.1:8543/laundry_v2` |

- **seed**：admin 幂等写入 orgs/stores/staffs
- **runtime**：`laundry_app` + 事务内 `SET LOCAL app.org_id/store_id`
- **盲查**（refresh hash / session / pin）：`0004_auth_lookup_functions.sql` SECURITY DEFINER

## 测试

```bash
# 内存 inject（无 Docker）
pnpm --filter @laundry/server test

# 仅 PG identity（需 compose + migrate-v2 含 0004）
LAUNDRY_USE_LOCAL_PG=1 node --test apps/server/dist/identity/pg-store.test.js

pnpm --filter @laundry/web test
```

### Cookie / 密码

| 环境              | Cookie 名                                        | Secure / SameSite                 | 密码哈希                                |
| ----------------- | ------------------------------------------------ | --------------------------------- | --------------------------------------- |
| 本地 HTTP（默认） | `laundry_refresh` / `laundry_csrf`               | Secure=false，SameSite=**Strict** | Argon2id（verify 仍接受 legacy scrypt） |
| 生产 HTTPS        | `__Host-laundry_refresh` / `__Host-laundry_csrf` | Secure=true，Strict               | 同上                                    |

- 强制 Secure：`LAUNDRY_COOKIE_SECURE=1` 或 `NODE_ENV=production`
- Argon2id 参数：m=19456 KiB，t=2，p=1（见 `ARGON2ID_DEFAULTS`）

### 总线 + 真 PG 冒烟

`local:server:pg` 时写命令与读查询都走 laundry_app + 事务 GUC：

| 路径                                           | 说明                               |
| ---------------------------------------------- | ---------------------------------- |
| `POST /v1/commands/platform.settings.set`      | 写 `settings` + 同事务 `audit_log` |
| `POST /v1/queries/platform.settings.get`       | 按 key 列表读 settings             |
| `POST /v1/queries/platform.store_features.get` | 读 store_features                  |
| `POST /v1/queries/platform.audit.list`         | 读 audit_log（无 secret 字段）     |

```bash
# 登录后
TOKEN=…  # access_token
curl -s -X POST http://127.0.0.1:8787/v1/commands/platform.settings.set \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"entries":[{"key":"pricing.min_order_cents","value_json":"1500"}]}'

curl -s -X POST http://127.0.0.1:8787/v1/queries/platform.settings.get \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"keys":["pricing.min_order_cents"]}'

curl -s -X POST http://127.0.0.1:8787/v1/queries/platform.audit.list \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"from_epoch_s\":0,\"to_epoch_s\":$(date +%s),\"limit\":20}"
```

集成测（opt-in）：

```bash
LAUNDRY_USE_LOCAL_PG=1 node --test apps/server/dist/__tests__/bus-pg-smoke.test.js
```

## 后续

- pin_lockouts 落表
- ADR-09 签署 → contracts@v0.1.0
- R5 step-up 真拦截（当前 step_up 仍放行执行）
