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

首次投产时，当前终端必须显式提供两位相互独立的管理员：

```text
LAUNDRY_BOOTSTRAP_ADMIN_USERNAME
LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME
LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD
LAUNDRY_BOOTSTRAP_ADMIN_PIN
LAUNDRY_BOOTSTRAP_APPROVER_USERNAME
LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME
LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD
LAUNDRY_BOOTSTRAP_APPROVER_PIN
```

确认八个变量已经设置后启动；两组用户名、密码和 PIN 必须分别不同，密码为
12–256 位，PIN 为 6–8 位数字：

```bash
: "${LAUNDRY_BOOTSTRAP_ADMIN_USERNAME:?set administrator username}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME:?set administrator display name}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD:?set administrator password}"
: "${LAUNDRY_BOOTSTRAP_ADMIN_PIN:?set administrator PIN}"
: "${LAUNDRY_BOOTSTRAP_APPROVER_USERNAME:?set approval administrator username}"
: "${LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME:?set approval administrator display name}"
: "${LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD:?set approval administrator password}"
: "${LAUNDRY_BOOTSTRAP_APPROVER_PIN:?set approval administrator PIN}"

export LAUNDRY_BOOTSTRAP_ADMIN_USERNAME
export LAUNDRY_BOOTSTRAP_ADMIN_DISPLAY_NAME
export LAUNDRY_BOOTSTRAP_ADMIN_PASSWORD
export LAUNDRY_BOOTSTRAP_ADMIN_PIN
export LAUNDRY_BOOTSTRAP_APPROVER_USERNAME
export LAUNDRY_BOOTSTRAP_APPROVER_DISPLAY_NAME
export LAUNDRY_BOOTSTRAP_APPROVER_PASSWORD
export LAUNDRY_BOOTSTRAP_APPROVER_PIN

pnpm local:up -- --bootstrap
```

后续启动已有数据库：

```bash
pnpm local:up
```

活动 profile 的组织和门店代码是 `local` / `main`。两位管理员的用户名、密码和 PIN
均来自首次显式输入，没有源码默认值；投产事务同时写入功能配置、投产标记和无秘密审计。

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

## 局域网 Owner Dashboard

局域网模式只提供手机响应式 `/owner` 只读入口。Fastify 仍映射到
`127.0.0.1:8787`，PostgreSQL 仍映射到 `127.0.0.1:8543`；主机上的 HTTPS 网关只
代理健康检查、登录、受保护的员工投影和三条固定 Owner 查询：
`reporting.owner_dashboard.get`、`reporting.owner_dashboard.drilldown`、
`reporting.owner_portfolio.get`；不会开放命令、照片、PIN 或任意其他查询路由。

正式安装态由 `Laundry Desk Runtime.app` 唯一托管，不要求目标 Mac 保留仓库、Node 或 pnpm。
Runtime GUI/CLI 提供 `lan configure|enable|disable|status|onboard|diagnose` 和
`support create`。`configure` 只从 GUI 内存或有界 stdin 接收地址、端口、公开证书和私钥；
其余命令不接收 stdin。`disable` 只移除 HTTPS gateway，回环 Server 继续可用；直接重新启用
或重新配置后启用都不需要店主处理 Compose 端口。

gateway 的容器 healthcheck 经 `127.0.0.1` 连接，却仍用公开 LAN IP 验证 CA、TLS 身份和
HTTP Host，且只接受有界时间、有界响应和 HTTP 200。Runtime 只有在 Compose `--wait`、
受信 `/health` 和 `/owner` 全部通过后才记录 enabled；失败会移除 gateway 并保持 disabled。
诊断和支持包只输出固定 schema 与稳定码，支持包权限为 `0600`、大小不超过 256 KiB，不包含
日志、PEM、路径、环境、业务字段或凭据。

### 仓库内开发调试（非正式安装入口）

先人工确认真实物理网卡的 RFC 1918 地址。macOS 可分别查看默认路由和物理接口地址：

```bash
route -n get default
ipconfig getifaddr en0
```

不要选择 `utun*`、Clash Verge TUN 常用的 `198.18.0.0/15`、回环或链路本地地址。网关
不会自动选网卡，也不会接受 `0.0.0.0`。下面以 `192.168.1.20:8443` 为例；证书必须包含
该 IP 的 SAN，并已由访问手机/电脑信任。证书和私钥都放在仓库外；私钥必须是唯一普通
文件（拒绝符号链接与硬链接），权限为 `0600`：

```bash
export LAUNDRY_LAN_BIND_HOST=192.168.1.20
export LAUNDRY_LAN_ORIGIN=https://192.168.1.20:8443
export LAUNDRY_TLS_CERT_FILE=/absolute/private/path/lan-cert.pem
export LAUNDRY_TLS_KEY_FILE=/absolute/private/path/lan-key.pem
chmod 600 "$LAUNDRY_TLS_KEY_FILE"
```

`LAUNDRY_LAN_ORIGIN` 必须在启动 Fastify 容器时已经存在，才能启用 Secure
`__Host-laundry_*` Cookie 和 `same-origin` Fetch Metadata 校验。首次安装仍需同时提供
两位管理员的八个 bootstrap 输入：

```bash
pnpm local:up -- --bootstrap
pnpm local:lan
```

已有数据库只需 `pnpm local:up`；若 Fastify 已按 loopback profile 启动，先执行
`pnpm local:down`，再带上述 LAN 环境重新 `pnpm local:up`，数据卷会保留。浏览器只打开：

```text
https://192.168.1.20:8443/owner
```

在第二台设备接入前，可从同一组 LAN 环境生成不含凭据的连接卡：

```bash
pnpm local:lan:onboard
```

终端二维码只编码上面的 `/owner` HTTPS URL，不包含组织、门店、用户名、密码、PIN、
token 或 Cookie；同时显示叶证书 SHA-256 指纹、IP SAN 和到期时间。若叶证书为自签名
证书，只把该公开证书作为信任锚传到设备；若由私有 CA 签发，只传签发 CA 的公开证书。
私钥不得传到手机、浏览器或扫码内容中。

- iPhone/iPad：安装公开证书描述文件后，在「设置 → 通用 → 关于本机 → 证书信任设置」
  显式启用完全信任；
- Android：在「安全 → 加密与凭据」安装签发 CA；不同厂商菜单名称可能略有差异；
- macOS：在「钥匙串访问」导入信任锚并显式设为信任。

安装后重新打开 URL，在登录前核对浏览器显示的叶证书 SHA-256 指纹与连接卡一致。
工具只提供指导，不会生成、复制或安装任何证书。

证书未被设备信任时不要点击浏览器警告继续。另一台设备应能访问 8443，但连接同一地址的
8787 和 8543 必须失败。错误 Host、跨站 Origin、`Sec-Fetch-Site` 非 `same-origin` 或
任何 `Forwarded` / `X-Forwarded-*` 都会被拒绝。

启动本地服务和 HTTPS 网关后，可运行 LAN 专项诊断：

```bash
pnpm local:lan:diagnose
```

诊断只输出固定 JSON 摘要：精确 Origin 配置、叶证书有效期/IP SAN/密钥匹配、回环
Fastify 健康、受信任 HTTPS `/owner` 与 `/health`，以及 LAN 地址上的 8787/8543 是否
意外可连接。它不读取日志、不发登录请求、不携带 Authorization/Cookie/PIN/CSRF，也不
输出证书或私钥路径、PEM 内容和底层异常文本。任一检查失败时命令以非零状态退出；该结果
不替代第二台真实设备与防火墙环境的走查。

自动化验收使用证书公钥的单一 SHA-256 SPKI pin，不启用全局
`ignoreHTTPSErrors`。在提供 bootstrap 登录环境与 `LAUNDRY_TEST_CERT_SPKI` 后执行：

```bash
pnpm local:lan:e2e
```

该用例在同一个非回环 HTTPS 地址创建两个隔离浏览器上下文，验证登录、四卡、7/30 日
切换、Secure Cookie、零命令请求和独立会话，并在第二上下文显式退出后刷新确认不能恢复
已注销会话。它是第二浏览器自动化证据，不替代手机安装证书后的真实设备走查。

Runtime 安装态另有两层门禁：`pnpm runtime:app:acceptance` 在无仓库、`PATH` 无 Node/pnpm
条件下连续验证 Runtime 与 LAN CLI；`pnpm runtime:lan:container:acceptance` 构建真实 Server
OCI，覆盖严格 gateway healthcheck、错误 Host/Origin/Forwarded/命令拒绝、LAN 侧
8787/8543 隔离、双浏览器会话、disable→enable、重新配置和资源零残留。后者依赖本机 Docker
与真实物理 RFC1918 地址，不在 GitHub required macOS job 中冒充可移植证据。

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
pnpm local:support-bundle
```

`local:support-bundle` 不接受参数，只在私有配置目录下的 `support-bundles/` 生成受管
JSON 文件。文件仅包含固定诊断分区；日志会先限长再脱敏，离线队列、CUPS 和升级状态
只输出计数或布尔摘要，不包含凭据、客户手机号、作业标识、密文、制品摘要或来源路径。
命令输出生成文件的路径、SHA-256 和字节数，便于线下交给支持人员核对。

自动维护入口会先生成新的完整恢复集，再按 30 天/30 份策略计算轮换。默认只报告待删除
集合；必须显式加 `--apply-retention` 才会删除，并且始终保留最新一份、拒绝删除损坏集合。
同一实例的备份、轮换和恢复演练由私有互斥锁串行化，结果写入
`maintenance-state.json`，`local:diagnose` 会把超过 26 小时、最近失败或状态损坏报告为
不健康：

```bash
pnpm local:maintenance
pnpm local:maintenance -- --apply-retention
```

macOS 可显式安装每天 03:00 的用户级 LaunchAgent；安装参数和 plist 不包含配置 secret：

```bash
pnpm local:maintenance:schedule -- --install
```

恢复演练不会修改生产库。它先校验数据库与每张照片，然后把 dump 恢复到随机命名的影子
数据库；影子库使用正式迁移器追平当前版本，再逐项核对当前源码中的迁移文件名、SHA-256
与关键 schema，最后删除影子库并记录演练时间。旧版本恢复集因此也会演练升级到当前版本：

```bash
pnpm local:restore:drill -- --file "/absolute/path/to/backup.dump" \
  --confirm-sha256 "<local:maintenance 输出的 backup.sha256>"
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

提供两位管理员的八个 bootstrap 输入后，可在隔离 PostgreSQL 数据卷上连续验证浏览器、打包 macOS
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
| `tools/local/maintenance.mjs`                | 自动备份、互斥与保留轮换      |
| `tools/local/restore-drill.mjs`              | 非破坏性影子库恢复演练        |
| `tools/local/maintenance-launchd.mjs`        | macOS 每日维护调度安装        |
| `tools/local/diagnose.mjs`                   | 无 secret 的本地诊断          |
| `tools/local/lan-gateway-config.mjs`         | LAN 地址与 TLS 文件失败关闭   |
| `tools/local/lan-gateway-core.mjs`           | 同源 HTTPS 静态/只读代理      |
| `tools/local/lan-gateway.mjs`                | Owner Dashboard LAN 入口      |
| `tools/local/lan-onboard.mjs`                | 无凭据连接 QR 与证书指引      |
| `tools/local/lan-diagnose.mjs`               | HTTPS/LAN 隔离安全诊断        |
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
