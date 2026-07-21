# 本地 Web Server 联调（M1）

优先路径：**内存 identity + Fastify API + Vite SPA**，不依赖 Postgres。

## 终端 A — API

```bash
pnpm local:server
# http://127.0.0.1:8787
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
curl -s -X POST http://127.0.0.1:8787/api/v2/auth/login \
  -H 'content-type: application/json' \
  -d '{"org_code":"hongfa","store_code":"main","username":"admin","password":"demo","device_id":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}' | jq .
```

## 终端 B — Web

```bash
pnpm local:web
# http://127.0.0.1:5173
```

默认 `VITE_API_BASE_URL=http://127.0.0.1:8787`（见 `apps/web/host/main.tsx`）。

## 实现位置

| 路径                                  | 作用                     |
| ------------------------------------- | ------------------------ |
| `apps/server/src/http/*`              | Fastify app + main entry |
| `apps/server/src/local/demo-seed.ts`  | 内存 demo 用户           |
| `apps/web/src/auth/HttpAuthClient.ts` | 浏览器 AuthClient        |
| `apps/web/host/main.tsx`              | Vite 入口                |
| `apps/web/vite.config.ts`             | 本地 host 配置           |

## 测试

```bash
pnpm --filter @laundry/server test   # 含 inject 测试
pnpm --filter @laundry/web test
```

## 后续

- 真 PG：`tools/compose/migrate-v2.sh` + 换 memory store
- cookie 名 / CSRF 与 contracts 描述符对齐强化
- 生产 Argon2id 替换 scrypt
