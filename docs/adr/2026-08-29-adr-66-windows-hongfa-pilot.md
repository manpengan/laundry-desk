# ADR-66：Windows V2 定制桌面版与宏发受控运营试点

- 日期：2026-08-29
- 状态：**Accepted**
- 决策者：manpengan（会话裁决：“后续主线，做 windows 定制 exe 版本，完了交 hongfa 进行实际运营实践”；并统一授权 Codex 在本范围内实施）
- 前序：[ADR-14：通用 V2 本地优先交付](2026-07-25-adr-14-generic-local-first-v2-delivery.md)、
  [ADR-37：Cloud Web 主交付线](2026-08-10-adr-37-cloud-web-primary-delivery.md)、
  [ADR-64：阶段 5 生产化接续](2026-08-17-adr-64-stage5-productionization-and-release-retention.md)、
  [ADR-65：Cloud 生产基线](2026-08-25-adr-65-cloud-production-baseline.md)
- 实机输入：[Windows 形态 findings 与构建机手册](../research/2026-08-29-windows-port-findings-and-build-host.md)
- 影响：活动路线、Windows 持久化与权限、桌面发行、打印、宏发定制、真实数据准入和试点验收

## 背景

阶段 1–4.5 已形成通用 V2 的 React SPA、Fastify/PostgreSQL、Electron Edge、离线队列、签名打印和
Cloud Web 基线。活动 Electron 包目前只有 macOS `dir` 目标，持久化、私有文件和打印运行时仍含
POSIX/CUPS 假设；仓库根 `build:win` 则属于冻结的 v1 Electron/SQLite 应用，不能代表 V2 Windows
交付。

2026-08-29 的 Windows 10 22H2 实机验证证明依赖安装和 TypeScript 图可通过，但暴露出三类必须先
裁决的边界：目录持久化、NTFS 私有 ACL、Windows 打印/安装。随后 manpengan 明确把后续主线改为
**活动 V2 的 Windows 定制 EXE，并交宏发做真实运营试点**。这恢复的是宏发作为通用 V2 的首个受控
发行与试点对象，不是恢复冻结 v1 或把宏发规则写回通用业务核心。

同一实机上的 Win32 探针取得了两项设计输入：以 `GENERIC_WRITE | FILE_FLAG_BACKUP_SEMANTICS` 打开的
目录句柄可成功执行 `FlushFileBuffers`；`MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` 可完成写穿透
替换。因此 Windows 不需要静默跳过持久化门禁，可以实现平台等价原语。

## 决策

### 1. 后续活动主线是 V2 Windows EXE → 宏发受控试点

交付顺序改为：

1. **W0 Windows 安全基座**：跨平台脚本、Win32 持久化、DACL、DPAPI 威胁模型与实机测试；
2. **W1 Windows 桌面发行**：活动 `apps/edge-agent` 的 x64 NSIS 安装器、安装/启动/卸载、GUI 自动化、
   Windows 打印接缝和受控更新/回滚；
3. **W2 试点生产准入**：独立 production-candidate、真实离机恢复、告警、容量、数据责任、宏发 v1
   只读迁移演练和切换/回退手册；
4. **W3 宏发受控运营**：限定机器、限定操作员、分阶段功能开放、每日核对、事故停止条件和运行证据。

ADR-64 的 5.1/5.2 安全门禁继续有效，但 Windows 桌面与 XP-58 不再排到 provider 之后；它们与生产
准入共同构成宏发试点关键路径。真实短信、微信、AI 或支付 provider 仍须各自真实凭据与回执，不因本
ADR 自动解锁。

### 2. 只复用活动 V2，不复活根 v1

- 产品代码继续位于 `apps/`、`packages/` 与 V2 工具；根 `src/`、根 `build:win` 和 v1 SQLite 只读。
- Windows 包必须由 `@laundry/edge-agent` 构建，并加载同一份经过完整性校验的 `apps/web` SPA。
- 宏发定制只能进入一个有模式校验的发行 profile：显示名、图标、固定服务 origin、安装标识和允许的
  设备类型。profile 不得包含密码、PIN、token、私钥、数据库 URL、真实顾客字段或运行时可编辑任意
  endpoint。
- 组织、门店、员工、价目和业务规则仍由服务端会话与数据库注入；核心代码不得以 `hongfa` 分支改变
  Command/Query、权限、计价或审计语义。

### 3. Windows 持久化必须使用等价 Win32 原语

新增一个最小、受测试且随包固定发布的 Windows 原生 helper，只有封闭子命令和有界输入：

- 文件内容先写唯一临时文件，设置私有 ACL，执行文件 `FlushFileBuffers`；
- 原子提交使用 `MoveFileExW` 的 `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`；
- 目录创建、删除或目录项变化后，以带 `FILE_FLAG_BACKUP_SEMANTICS`、`GENERIC_WRITE` 的目录句柄执行
  `FlushFileBuffers`；
- helper 缺失、摘要不符、返回不完整或 Win32 调用失败时，调用方失败关闭；不得在 `win32` 分支直接
  `return`、吞掉 `EPERM` 或把未刷盘操作报告成功。

POSIX 继续使用既有 `file fsync → rename → parent directory fsync`。测试必须在两套平台分别注入提交
前、提交中和提交后崩溃，证明旧指针或新指针可恢复，不能出现指向半写内容的成功状态。

### 4. `0600` 在 Windows 上表达为受保护 DACL

Windows 私有文件不再比较虚假的 POSIX mode，而采用以下等价不变量：

- 路径是唯一普通文件，不是 reparse point/symlink，硬链接数为 1；
- owner 是当前运行身份；DACL 关闭继承；
- 仅当前用户 SID 与 `NT AUTHORITY\\SYSTEM` 拥有所需控制权，不允许 Everyone、Users、
  Authenticated Users 或未知宽泛主体访问；
- 写前、打开后、读后/提交后复核文件身份与规范化安全描述符，保持现有 TOCTOU 防护强度；
- 需要把权限纳入摘要时，Windows 使用版本化、规范化 DACL 投影，不伪造 `0o600`。

ACL 设置和验证由同一受限 helper 完成。不能解析本地化 `icacls` 文本，也不能仅因 Windows 就放宽
私钥、release 输入、队列 KEK、授权信任或更新状态的检查。

### 5. Windows 接受 DPAPI CurrentUser，并明示同用户进程边界

Electron `safeStorage` 在 Windows 上使用 DPAPI CurrentUser。宏发试点接受该平台属性，并以受保护
DACL、专用 Windows 登录用户、锁屏/离岗规则和 Defender 保持开启作为补偿。以同一用户身份执行的
恶意进程可能调用 DPAPI 解密，这是已接受的剩余风险，不得写成等价于 macOS Keychain 的授权提示。

若 `safeStorage.isEncryptionAvailable()` 为 false、落入 plaintext backend，或用户 profile 无法加载，
应用不得生成/读取生产设备私钥，也不得进入可写运营模式。

### 6. Windows 打印在 `signed-executor` 接缝实现

- 保留派发签名验证、单调时限、durable ledger、一次性执行门和签名回执，不另写旁路打印链。
- 把当前 CUPS 专用 executor 端口抽象为固定“发现 + RAW 提交”设备端口；macOS 继续 CUPS。
- Windows 优先使用 Win32 Print Spooler 的 `EnumPrinters/OpenPrinter/StartDocPrinter/WritePrinter` RAW
  通道；已有 `usb-port.ts` 的 COM/LPT/USB 直写保留为明确配置的设备 smoke/后备端口。
- 队列名/设备名必须通过平台 schema；helper 只接收固定子命令和有界 stdin，不接受 shell 命令、任意
  DLL、URL 或 Header。
- 软件成功只证明 Windows spooler 接受了固定字节；宏发现场必须分别核对 XP-58 出纸、中文、金额、
  条码、走纸、切刀、断连、补打与重复保护。

### 7. Windows 发行与验证边界

- 首个目标为 Windows 10 22H2 build 19045 与 Windows 11 x64；不承诺 ARM64。
- 开发包可未签名但必须标记 `development_only` 并附 SHA-256；进入宏发运营前必须确定 Authenticode
  签名或由受控内网安装政策显式接受未签名内部包，不能把 SmartScreen 绕过冒充签名完成。
- 发行物是 NSIS 安装器 `.exe`；安装默认不删除 `%APPDATA%` 业务状态，卸载/升级与数据删除是不同
  动作。升级失败必须能回到前一安装器与同一数据状态。
- 自动验收使用 Playwright `_electron` 驱动**打包后的 V2 可执行文件**，覆盖启动、登录、柜台壳、
  安全 webPreferences、单实例、托盘、离线状态、关闭/重启和无 PII 截图。RustDesk 只用于人工可见
  复核；远程画面不能替代现场 60fps 或实体打印证据。
- 根 v1 `build:win`、浏览器 Vite 页面和系统 Edge 的通过都不能作为 Windows V2 EXE 交付证据。

### 8. 宏发真实运营准入仍需生产与数据门禁

宏发可收到 development/pilot 安装器做合成数据走查；导入真实顾客数据或开始记真实账前必须同时满足：

1. ADR-65 的独立 production-candidate、离机恢复、告警、容量与事故路径取得真实证据；
2. 固定桌面 origin 绑定该 production-candidate，不复用 `hk-vps-cloud-test`；
3. 两位独立管理员投产、权限复核、备份/恢复点、访问责任人、试点 SLO 和停止条件落档；
4. 若迁移 v1，先对获授权的 checkpointed 只读备份运行零差异 dry-run，再由 schema-owned loader 在
   备份点后单事务导入；不得直接读取或写入宏发 live SQLite；
5. 三类现役打印机按各自指令族实测；未通过的设备能力保持关闭，不用 mock 冒充；
6. 首周逐日核对订单数、件数、整数分应收/实收/欠款、会员账本、打印回执、备份和异常；重大差异立即
   停写并按手册回退。

试点证据只能记录计数、摘要、稳定错误码与时间，不保存顾客姓名、手机号、地址、照片、票据正文、
凭据或数据库连接信息。

## 理由

- 复用 V2 Electron/SPA/Server 能让宏发试点验证通用产品，而不是产生第二套单店业务分叉。
- 实机证明 Win32 可提供目录刷盘和写穿透替换，保留崩溃安全比平台跳过更可靠。
- DACL 和 DPAPI 是 Windows 的原生安全表达；把它们明确建模比伪造 POSIX mode 更可审计。
- 在 signed executor 接缝替换设备端口，能完整保留权威派发、去重和回执不变量。
- 把开发安装器与真实数据准入分开，允许桌面工程快速推进，同时不把未完成的生产恢复链施加于顾客
  数据。

## 否决的备选

- **运行根目录 v1 `build:win` 交付宏发**：绕开 V2 Server/RLS/Command Bus 与当前数据模型，否决。
- **`process.platform === "win32"` 时跳过目录 fsync**：静默削弱原子发布和队列恢复，否决。
- **Windows 上忽略 `0600`**：使私钥、KEK 和 release 输入失去等价访问边界，否决。
- **从头重写打印链**：会丢失签名派发、ledger 和回执不变量，否决。
- **把浏览器/Edge 截图当桌面 EXE 验收**：未验证 Electron 主进程、preload、安装或设备能力，否决。
- **直接把 hk-vps staging 装入真实宏发数据**：违反环境隔离与可恢复性准入，否决。
- **把宏发常量写进通用业务代码**：制造无法复用、难迁移的客户分叉，否决。

## 后果

- ADR-14 “宏发不作为发布目标”和 ADR-64 “桌面排在 provider 后”的顺序由本 ADR覆盖；V2-only、
  根 v1 冻结、通用业务契约和真实数据保护要求不变。
- Windows 会增加一个可审查的原生 helper、平台安全抽象、NSIS 发行配置和实机门禁。
- 首个可启动 `.exe` 不自动等于可交宏发记真实账；生产基础设施、签名、迁移和实体打印任一门禁未关闭
  时，状态必须精确保持 development/pilot 或 blocked，不得称正式运营完成。
- 宏发是通用 V2 的首个受控发行 profile 和试点对象；后续门店应复用同一核心与 profile schema，而不
  复制业务代码。
