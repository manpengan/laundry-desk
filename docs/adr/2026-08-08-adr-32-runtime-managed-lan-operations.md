# ADR-32：Runtime 托管的局域网运维入口

- 日期：2026-08-08
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-21：独立 macOS Runtime.app](2026-08-01-adr-21-independent-macos-runtime-app.md)、[ADR-26：局域网只读 Owner Dashboard](2026-08-07-adr-26-lan-owner-dashboard.md)、[ADR-28：LAN 设备接入与证书诊断](2026-08-08-adr-28-lan-onboarding-diagnostics.md)、[ADR-31：新店投产与员工凭据](2026-08-08-adr-31-store-commissioning-staff-credentials.md)
- 影响：Runtime.app、签名 Server OCI、Compose、LAN HTTPS、诊断与支持包

## 背景

ADR-26/28 已冻结安全的 Owner HTTPS 网关、接入二维码和诊断工具，但当前启动仍依赖仓库、
Node/pnpm、终端环境变量和人工并排维护多个进程。正式本地产品不能要求店主进入源码目录，
也不能为简化启动而把 Fastify、PostgreSQL、任意代理或证书私钥暴露到局域网。

Runtime.app 已是唯一主机级安装、启停、诊断、恢复和升级权威，因此 LAN 生命周期也必须进入
同一原生入口，同时保持 Counter、Web、Fastify 命令面与数据库权限不变。

## 决策

### 1. 网关运行在签名 Server OCI 中

现有 Node HTTPS 网关核心随 Server OCI 固化发布；目标 Mac 不需要安装 Node、pnpm 或仓库。
启用 LAN 时，Runtime 使用签名且校验和绑定的 Compose overlay 启动专用 gateway service，
它与 Server 共享网络命名空间，只访问 `127.0.0.1:8787`。宿主只把 gateway 的 HTTPS 端口
映射到操作者显式选择的 RFC1918 IPv4；Fastify `8787` 与 PostgreSQL `8543` 仍只映射
`127.0.0.1`。

OCI 只携带已同步、内容寻址且通过完整性校验的 Owner SPA 和固定网关模块。入口只接受
`lan-gateway` 这一固定命令及文件型配置，不执行 shell，不接受任意上游 URL、静态目录或路由。
网关代理面继续精确等于 ADR-26/27 的七条只读/认证路由；所有命令、柜台根页面、诊断、文件和
照片路由继续返回拒绝。

gateway 必须带 OCI 内嵌的固定 Node healthcheck。探针只从固定 secret 路径读取严格 profile
与公开证书，经 `127.0.0.1` 连接本机网关，但 TLS server name、证书 IP 身份和 HTTP Host
都使用 profile 中的公开地址；CA 校验不得关闭。探针只接受有界时间、有界响应和 HTTP 200，
不得使用 `curl -k` 或输出响应体、PEM、路径和底层异常。Compose `up --wait` 以该探针为
gateway 已经真实监听的提交门禁。

### 2. Runtime 持有唯一 LAN profile 与秘密

Runtime 新增 `lan configure|enable|disable|status|onboard|diagnose` 与 GUI 对应入口。
`configure` 只通过 stdin 或 GUI 内存接收 bind IPv4、显式高端口、公开证书 PEM 和私钥 PEM；
不得从 argv、宿主环境、日志或支持包读取/输出秘密。Runtime 必须验证：

- 地址为当前 UP 的非 loopback、非 utun、非 point-to-point 接口上的单一 RFC1918 IPv4；
- 端口为 `1024..65535`，且不等于 `8543`/`8787`；
- 证书当前有效、IP SAN 精确匹配、私钥匹配；私钥为 `0600`、普通单链接文件；
- profile、证书和私钥写入 `0700` generation 目录，经 fsync 后原子切换，旧代不自动冒充活动配置。

持久 profile 只保存版本、状态、地址、端口、证书指纹/有效期、generation 和校验摘要，不保存
PEM。`enable` 在启动前重做接口、证书、端口和 manifest/overlay 校验；失败保持 LAN 停止。
`disable` 只停止/移除 gateway，不停止回环 Counter 服务，也不删除最后一份可诊断配置。
普通 `disable` 后再次 `enable`、已启用时重新 `configure` 后再 `enable` 都必须无需人工处理
Compose 端口；Runtime 不得把本项目 Server 遗留的同地址映射误判成外部占用。任一启动或
状态提交失败都要精确移除 gateway、保持 Server 回环健康；启动失败收敛为 disabled，状态
无法安全提交时进入明确的不确定隔离态，不得伪报 enabled。

CLI 冻结为：`lan configure` 从不超过 32 KiB 的 stdin 接收精确 JSON
`{bind_ipv4,port,certificate_pem,private_key_pem}`；其余五个 `lan` 子命令和
`support create` 均拒绝 stdin。stdout 只返回排序后的固定 JSON schema，错误只返回稳定码。

### 3. 发布与升级绑定 LAN overlay

Runtime manifest v2 精确新增 `lan_compose_sha256` 与 `owner_spa_sha256`，分别绑定 LAN overlay
和内嵌 Owner SPA。v1 manifest 可继续运行回环服务，
但必须拒绝启用 LAN；升级/回滚沿用 ADR-30 的签名候选、原子 transition 与安全点语义，并在
切换后重新验证活动 LAN profile。不存在隐式自动启用：升级只恢复原先明确 enabled 的状态，
验证失败则 LAN 保持关闭并报告稳定错误码。

### 4. 接入、诊断和支持包保持脱敏有界

`onboard` 只返回 `/owner` URL、终端二维码、证书指纹/有效期/IP SAN 和人工信任指引，不返回
PEM、路径、组织/门店、账号、密码、PIN、Cookie 或 token。

`diagnose` 以固定超时和大小上限检查 profile/证书/接口、回环 Server、受信 HTTPS `/owner`
与 `/health`、gateway 容器状态，以及 LAN 地址无法直连 8787/8543。输出只含固定检查码、
布尔值和允许的证书摘要；原始异常、响应体、Compose 环境和本地路径不得出现。

`support create` 生成单个 `0600`、单链接、至多 256 KiB 的严格 JSON，只包含 Runtime/Server/
LAN/备份/打印的稳定状态码、版本和计数。它不收集任意日志、环境、数据库内容、顾客/订单/
员工字段、证书/密钥路径、Cookie/token/PIN 或队列明文。
顶层字段精确为 `schema_version`、`generated_at`、`runtime`、`server`、`lan`、`backup`、
`printing`，不得追加原始文本或任意路径字段。

### 5. 验收

- 无仓库、PATH 无 Node/pnpm 的 Runtime.app 可配置、启用、重启、禁用 LAN，并在 launchd 重启后
  恢复明确 enabled 状态；Counter 回环服务始终独立可用。
- 真实容器从签名镜像启动 gateway；另一浏览器上下文经受信 HTTPS 完成 Owner 登录、查询和
  注销；错误 Host/Origin/Forwarded、命令路由和柜台根页面全部失败关闭。
- LAN 地址的 8787/8543 连接失败；错误接口、证书过期/SAN/key 不匹配、端口占用、overlay/
  SPA 摘要漂移和 v1 manifest 均不得启动 gateway。
- `disable` 后 Server ID 与回环健康保持有效；重新启用时先释放本项目遗留的 LAN 映射，再由
  overlay 恢复映射，并且 Server/gateway 都通过 healthcheck 与受信 HTTPS 门禁。
- 诊断、二维码与支持包通过固定 schema、权限、大小和 canary 泄密负测；所有隔离容器、网络、
  卷、证书和临时目录在验收后清理。

## 后果

- 店主不再需要源码、pnpm 或终端编排 LAN；Runtime 成为唯一主机运维入口。
- LAN 仍只提供只读 Owner 产品面，不新增云访问、远程隧道、自动证书签发、MDM、命令写入或
  客户端 IP 信任链。
- Developer ID、公证、正式 OCI 签名与第二台真实设备的证书安装仍是独立外部证据；本机
  ad-hoc/私有 CA 验收不能替代它们。

## 否决的备选

- **把 Fastify 或 PostgreSQL 直接绑定 LAN**：扩大数据库和命令面，否决。
- **在 Runtime 内重写一套 HTTPS 代理**：形成第二套安全边界和路由漂移，否决。
- **要求目标机安装 Node/pnpm 或保留仓库**：不符合无仓库运维，否决。
- **自动选择网卡、监听 `0.0.0.0` 或接受 utun/TUN**：可能把服务暴露到错误网络，否决。
- **自动安装根证书或输出完整配置/日志**：扩大主机权限并增加泄密面，否决。
