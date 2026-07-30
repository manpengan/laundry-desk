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
单文件上限 8 MiB。服务端完整解码图像、核对声明格式、限制像素和帧数，并重新编码去除
EXIF 等元数据后才落盘。上传使用稳定 `upload_id`，网络失败后界面可用同一 ID 安全重试；
同一 ID 携带不同内容会拒绝。详情提供缩略图、原图查看、加载重试和二次确认删除，删除
元数据与审计在同一数据库事务内完成，随后清理私有文件。

上传与下载只走受认证、CSRF 保护的固定照片路由。浏览器通过 `PhotoPort` 使用内存中的
access token；macOS 渲染进程只能调用专用的 `desktop:photo:upload`，不能选择 URL、
HTTP 方法、Header、Cookie 或设备身份。
上传成功结果在 HTTP、Electron IPC 与 React 端都按严格照片元数据契约校验，私有
`storage_key` 或非法 ID 不能进入渲染进程。macOS 还使用独立的
`desktop:photo:read` / `desktop:photo:delete` 固定能力。列表或二进制读取失败时界面
显示可重试错误，不会把故障伪装成“暂无照片”。

## 打印工作器

配置 `LAUNDRY_PRINT_SPOOL_DIR` 后，本地服务会在 HTTP 监听成功后启动租约打印工作器，
停止服务时等待当前周期结束后再关闭 PostgreSQL。工作器按批次领取任务，失败只记录稳定
错误码；队列界面显示运行状态、累计成功/失败和 spool 留存数量/字节。spool 只删除自己
生成的文件，并同时受数量和总字节上限约束。失败任务的“重试”和已完成任务的“补打”
都会创建新任务，不复活终态记录。

客户详情会聚合最近订单、欠款余额和打印状态；点击订单可继续查看照片及柜台操作。

## 备份、恢复和诊断

灾备恢复集写入私有配置目录下的 `backups/`（目录 `0700`、文件 `0600`）。工具先停止
API，在同一静止窗口生成 PostgreSQL dump 与私有照片快照，再用 `.bundle.json` 的
SHA-256 绑定实例、数据库和每张照片；完成后恢复 API：

```bash
pnpm local:backup
pnpm local:diagnose
```

恢复是破坏性操作，只接受该实例 `backups/` 内完整且校验通过的恢复集，并要求显式重复
输出的 `Confirm SHA-256`。恢复前会自动再做一份包含数据库和照片的 `pre-restore`
安全备份；数据库在单一事务中恢复，照片通过私有目录原子换入，全部成功后才重新启动 API：

```bash
pnpm local:restore -- --file "/absolute/path/to/backup.dump" \
  --confirm-sha256 "<local:backup 输出的 Confirm SHA-256>"
```

诊断只输出实例标识、服务就绪状态、可用空间和私有目录统计，不输出配置 secret。

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

| 路径                                         | 作用                          |
| -------------------------------------------- | ----------------------------- |
| `tools/local/config.mjs`                     | 仓库外配置生成、权限和校验    |
| `tools/local/up.mjs`                         | PG、migration、bootstrap、API |
| `tools/local/down.mjs`                       | 停止服务并保留数据卷          |
| `tools/local/reset.mjs`                      | 受确认保护的默认卷删除        |
| `tools/local/backup.mjs`                     | 数据库与照片一致性灾备        |
| `tools/local/restore.mjs`                    | 校验、预备份与整体恢复        |
| `tools/local/disaster-recovery.mjs`          | 恢复集清单、照片校验与换入    |
| `tools/local/diagnose.mjs`                   | 无 secret 的本地诊断          |
| `tools/compose/docker-compose.yml`           | loopback-only 服务拓扑        |
| `apps/server/src/local/profile.ts`           | 通用 `local/main` profile     |
| `apps/server/src/local/bootstrap.ts`         | profile/schema readiness      |
| `apps/server/src/http/main.ts`               | Fastify 入口                  |
| `apps/server/src/photo/file-store.ts`        | 私有照片文件安装与完整性校验  |
| `apps/server/src/print/worker-controller.ts` | 打印工作器生命周期与健康      |

单元测试不要求 Docker：

```bash
pnpm --filter @laundry/server test
pnpm --filter @laundry/web test
```
