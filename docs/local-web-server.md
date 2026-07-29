# 通用 V2 本地联调

本地手工验收、浏览器走查和 macOS App smoke 均使用真实 PostgreSQL。memory
runtime 只用于单元测试，不作为本地交付证据。

## 地址与进程

| 组件       | 地址                    | 说明                         |
| ---------- | ----------------------- | ---------------------------- |
| PostgreSQL | `127.0.0.1:8543`        | Compose 内的 PostgreSQL 16   |
| Fastify    | `http://127.0.0.1:8787` | Compose 内的 `local-pg` 服务 |
| Vite Web   | `http://127.0.0.1:5173` | 单独启动的浏览器开发入口     |

PostgreSQL 与 Fastify 只绑定 `127.0.0.1`，不会发布到局域网。浏览器地址也固定
使用 `127.0.0.1`，不要混用 `localhost`。

## 启动本地服务

首次创建管理员时，当前终端必须显式提供：

```text
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD
LAUNDRY_BOOTSTRAP_ADMIN_PIN
```

确认四个变量已经设置后启动：

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

后续启动已有数据库：

```bash
pnpm local:up
```

活动 profile 的组织和门店代码是 `local` / `main`。管理员用户名、密码和 PIN
均来自首次显式输入，没有源码默认值。

检查 API：

```bash
curl --fail http://127.0.0.1:8787/health
bash tools/compose/smoke-rls.sh
LAUNDRY_LOCAL_ORG_CODE=local \
LAUNDRY_LOCAL_STORE_CODE=main \
  bash tools/compose/smoke-test.sh
```

HTTP smoke 还需要保留首次 bootstrap 使用的管理员用户名和密码环境变量。

## 启动 Web

保持本地服务运行，在另一个终端执行：

```bash
pnpm local:web
```

浏览器打开 `http://127.0.0.1:5173`，使用 `local` / `main` 以及显式创建的
管理员凭据登录。Web 默认连接 `http://127.0.0.1:8787`。

Playwright 走查同样连接真实 PostgreSQL：

```bash
pnpm exec playwright install chromium
LAUNDRY_LOCAL_ORG_CODE=local \
LAUNDRY_LOCAL_STORE_CODE=main \
  pnpm local:web:e2e
```

运行 E2E 的终端需要提供与 bootstrap 相同的管理员用户名和密码环境变量。

## 本地配置

首次 `local:up` 会在仓库外生成数据库和签名 secret。macOS 默认路径：

```text
~/Library/Application Support/laundry-desk-v2/local/config.json
```

目录权限为 `0700`，文件权限为 `0600`。配置不符合预期、是符号链接或内容被
修改时，生命周期命令会失败。测试和 CI 可用绝对路径
`LAUNDRY_LOCAL_CONFIG_DIR` 指向独立目录。

管理员密码和 PIN 不写入该文件。不要手工复制、提交或打印 `config.json`。
配置同时保存一个非敏感的随机实例标识，用于给本地数据卷标记归属。

衣物照片保存在同一私有配置目录下的 `photos/`，Compose 只把这个目录挂载到
Fastify 容器。目录和文件分别强制为 `0700` / `0600`，文件名由服务端生成；数据库
仅保存不可由客户端指定的存储 key、内容摘要和元数据。服务端只接受容器内固定挂载点
`/var/lib/laundry/photos`，且只在空目录中建立 `.laundry-photo-store-v1` 所有权标记
后调整目录权限；已有非照片内容或符号链接路径会拒绝启动，不会被改权或清理。

## 照片工作流

订单必须先包含至少一件衣物。打开订单详情后，可选择 JPEG、PNG 或 WebP 文件并上传；
单文件上限 8 MiB。服务端校验真实文件头、租户和订单/衣物关系，成功后重新打开详情仍
可看到持久化的照片记录数。当前 UI 尚未提供缩略图和删除操作。

上传与下载只走受认证、CSRF 保护的固定照片路由。浏览器通过 `PhotoPort` 使用内存中的
access token；macOS 渲染进程只能调用专用的 `desktop:photo:upload`，不能选择 URL、
HTTP 方法、Header、Cookie 或设备身份。
上传成功结果在 HTTP、Electron IPC 与 React 端都按严格照片元数据契约校验，私有
`storage_key` 或非法 ID 不能进入渲染进程。列表读取失败时界面显示可重试错误，不会
把故障伪装成“暂无照片”。

## 一键验收

提供四个 bootstrap 输入后，可在隔离 PostgreSQL 数据卷上连续验证浏览器、打包 macOS
应用、服务中断和恢复：

```bash
pnpm local:acceptance
```

命令完成时输出 `LOCAL_ACCEPTANCE_OK`，并清理其隔离服务和数据卷。macOS 产物仍是
本地测试用的未签名、未公证 `.app`。

## 停止与清空数据

正常停止会保留 `laundry-desk_pgdata-v2`：

```bash
pnpm local:down
```

只有需要清空默认本地数据库时才运行：

```bash
pnpm local:reset -- --confirm DELETE-laundry-desk-v2-local
```

reset 只接受默认 `laundry-desk` project，只删除
`laundry-desk_pgdata-v2`；它会在停止服务前和删除前分别核对 managed、project
和实例标识三个卷标签，任一不匹配就拒绝操作。reset 不会删除仓库外配置。
完成后必须使用 `pnpm local:up -- --bootstrap` 重新创建管理员。

## 相关实现

| 路径                                  | 作用                          |
| ------------------------------------- | ----------------------------- |
| `tools/local/config.mjs`              | 仓库外配置生成、权限和校验    |
| `tools/local/up.mjs`                  | PG、migration、bootstrap、API |
| `tools/local/down.mjs`                | 停止服务并保留数据卷          |
| `tools/local/reset.mjs`               | 受确认保护的默认卷删除        |
| `tools/compose/docker-compose.yml`    | loopback-only 服务拓扑        |
| `apps/server/src/local/profile.ts`    | 通用 `local/main` profile     |
| `apps/server/src/local/bootstrap.ts`  | profile/schema readiness      |
| `apps/server/src/http/main.ts`        | Fastify 入口                  |
| `apps/server/src/photo/file-store.ts` | 私有照片文件安装与完整性校验  |

单元测试不要求 Docker：

```bash
pnpm --filter @laundry/server test
pnpm --filter @laundry/web test
```
