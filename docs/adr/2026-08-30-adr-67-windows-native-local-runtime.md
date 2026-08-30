# ADR-67：Windows 独立原生本地 Runtime

- 日期：2026-08-30
- 状态：**Accepted**
- 决策者：manpengan（会话裁决：修复已安装 Windows EXE 的本地服务未就绪问题，并统一授权 Codex 在
  Windows 定制 EXE 主线内实施）
- 前序：[ADR-21：独立 macOS Runtime.app](2026-08-01-adr-21-independent-macos-runtime-app.md)、
  [ADR-66：Windows V2 定制桌面版与宏发受控运营试点](2026-08-29-adr-66-windows-hongfa-pilot.md)
- 影响：Windows 本地服务拓扑、安装生命周期、PostgreSQL 发行、开发验收与宏发准入

## 背景

首个 Windows development-only NSIS 安装器已能安装并启动活动 V2 Electron，但安装内容只有柜台壳和
Edge 能力。柜台固定探测 `127.0.0.1:8787/health`，目标机没有 PostgreSQL、Fastify、Docker 或 WSL，
因此已安装 EXE 正确停在“本地服务尚未就绪”。Clash 只影响外网下载，不参与 loopback 请求，也不是该
故障的根因。

产品设计与 ADR-21 已规定 PostgreSQL/Fastify 独立于 Electron 运行。Windows 不能为了单个安装包变绿而
隐藏 ServiceGate、伪造健康响应、恢复 v1 SQLite，或把数据库生命周期塞入 Electron 主进程。

目标实机为 Windows 10 Home 22H2。当前 Docker Desktop 支持矩阵和该系统的 WSL 未启用状态，使
Docker/WSL 不适合作为这条 Windows 试点线的默认前置条件；PostgreSQL 官方 Windows 下载页则明确提供
可供应用集成的 EDB binary zip。因此 Windows 采用原生 PostgreSQL 运行时。

## 决策

### 1. Windows 保持独立 Runtime + Counter 双产品结构

- `laundry-desk V2.exe` 仍只负责柜台 Electron、设备和离线边缘能力；它只探测固定 loopback 健康端点，
  不启动、停止或拥有数据库进程。
- 独立 Windows Runtime 管理 PostgreSQL 16、迁移、角色、一次性 bootstrap、Fastify 和登录自启。
- PostgreSQL 只监听 `127.0.0.1:8543`，Fastify 只监听 `127.0.0.1:8787`；不新增局域网或公网入口。

### 2. 原生 Runtime 不降低数据库和密钥不变量

- PostgreSQL 使用官方 Windows x64 binary zip，发行版本和 SHA-256 必须显式绑定；正式包还须保留上游
  来源记录和发布清单绑定。
- 新 cluster 启用 UTF-8、data checksums 与 SCRAM；superuser、`laundry_app`、token 和 CSRF secret
  独立随机生成，不进入源码、命令行或日志。
- 数据目录、secret 文件、operator handoff 和启动脚本位于当前用户的 LocalAppData 私有根，使用
  ADR-66 的受保护 DACL helper 创建并复核。
- 继续执行同一 migration bundle、ledger 校验、`laundry_owner`/`laundry_app` 权限和真实 bootstrap；
  健康门禁只在这些条件真实满足后通过。
- 登录任务禁止 Task Scheduler hard terminate；受控停机先验证并结束 8787 的 Server 进程，再由
  `pg_ctl fast` 完整关闭 PostgreSQL。不得用 `Stop-ScheduledTask` 强杀整个进程树。
- 安装与停机脚本启动 `pg_ctl` 时必须隔离 PowerShell/SSH 输出句柄，并只等待直接 `pg_ctl` 进程；不得
  用会等待后台 postgres 后代进程树的 native pipeline 或 `Start-Process -Wait`。
- launcher 显式清除 container/LAN/public 拓扑、未启用的照片/打印目录和 Node 注入环境，避免登录环境
  把 development Runtime 改绑到 `0.0.0.0` 或加载未授权 Node 模块。

### 3. development 修复与 pilot 发行分层

- 当前 W1.5 development Runtime 可使用构建机已安装的 Node 和仓库构建产物，并由受控登录任务自启；
  它只允许合成数据，operator 凭据随机生成到私有 development-only handoff 文件。
- 可交付的 Windows Runtime companion 必须进一步携带固定 Node、Server、migrations 与 PostgreSQL，
  做 no-repo 安装/升级/停止/重启/卸载保留数据验收，并纳入 Authenticode 和 release manifest。
- Counter 安装器可安装或明确引导 Runtime companion，但 Electron 启动不得成为数据库生命周期所有者。

## 理由

- 与 macOS 的独立 Runtime 架构一致，桌面崩溃、更新或卸载不会自动取得数据库所有权。
- 原生 PostgreSQL 避免把 Windows 10 Home、WSL2 和 Docker Desktop 变成宏发试点的额外运行条件。
- 复用现有迁移、RLS、角色和 bootstrap 能修复真实缺口，而不是建立仅让 UI 变绿的第二套数据路径。
- development/pilot 分层允许先恢复实机软件验证，同时保持签名、恢复、硬件和真实数据门禁可审计。

## 否决的备选

- **在 Electron 内启动 PostgreSQL/Fastify**：混淆壳与数据生命周期所有权，否决。
- **隐藏 ServiceGate 或返回假 `ready`**：使柜台在数据库未就绪时进入写面，否决。
- **恢复根 v1 SQLite**：违反 V2-only 与 PostgreSQL/RLS 基线，否决。
- **把 Docker Desktop 设为 Windows 10 Home 的默认依赖**：目标环境不匹配且增加 WSL 运维面，否决。
- **把随机密码写入源码、安装参数或普通日志**：破坏密钥边界，否决。

## 后果

- W1 的首个 NSIS 证据修正为“桌面壳完成”；W1.5 负责关闭独立 Runtime、真实健康和安装版 UI。
- development Runtime 通过不等于宏发可记真实账；ADR-65/66 的恢复、签名、打印、数据责任和现场停止
  条件继续生效。
- Windows 发行体积会增加，后续需要对固定 Node/PostgreSQL payload、增量升级和保留数据卸载分别取证。
