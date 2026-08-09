# ADR-34：设备本地 CUPS 打印配置与实体验收边界

- 日期：2026-08-08
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-16：边缘运营范围追认与契约面门禁](2026-07-31-adr-16-edge-operations-scope-ratification.md)、[ADR-20：权威边缘打印派发](2026-08-01-adr-20-authoritative-edge-print-dispatch.md)
- 影响：柜台 Electron 主进程、preload/IPC、Web Settings、macOS CUPS 与 XP-58 验收

## 背景

ADR-20 已把订单小票收敛为 Server 权威快照、一次性签名派发、Edge 验签执行和设备签名回执，
但生产 CUPS 队列仍只能在进程启动前通过 `LAUNDRY_CUPS_QUEUE` 提供。打包 App 没有安全、可观察
的配置入口；普通启动也不能在领取任务前证明该队列仍安装。另一方面，既有
`LAUNDRY_PRINTER_PATH` 与 Windows/POSIX USB smoke 是旧的装机诊断边界，不能作为 macOS 签名
CUPS 派发的生产配置，更不能把 CUPS 接单冒充实际出纸。

本 ADR 只增加单台柜台 Mac 的外设配置能力，不新增 Server 命令、查询、HTTP 路由、数据库字段
或租户级 `platform.settings`。

## 决策

### 1. 队列选择属于设备本地状态

当前队列保存于 `<Electron userData>/edge-state/printing/printer-config.json`，格式严格固定为
`{"version":1,"queue":<安全队列名|null>}`。目录与文件分别为 `0700`、`0600`，拒绝符号链接、
硬链接、越界路径、超限内容、未知字段和非法版本，并使用临时文件、fsync 与原子 rename 替换。

队列名只接受 1–64 位 ASCII 字母、数字、点、下划线和连字符，并且写入前必须由固定
`/usr/bin/lpstat -e` 重新发现。配置文件存在后它是唯一权威；`LAUNDRY_CUPS_QUEUE` 只在配置文件
尚不存在时作为一次兼容 bootstrap，验证成功后立即迁移进该文件。它不是持续覆盖 UI 选择的
隐藏优先级。`LAUNDRY_PRINTER_PATH` 继续只服务旧 USB/Windows CLI 诊断。

### 2. Renderer 只获得四个具名管理员能力

preload 只暴露 `printer.discover`、`printer.status`、`printer.configure` 和
`printer.test` 四个固定通道。每次调用同时校验 `app://local` 主 frame、参数数量、strict Zod
输入/输出和当前主进程内存会话；未登录或非 admin 一律失败关闭，恢复模式禁止修改与试打。

- `discover/status` 只返回安全队列名、当前选择、`disabled|ready|unavailable` 与稳定消息；
- `configure` 只接受已发现队列或 `null`，不接受路径、URI、PPD、可执行文件、argv 或原始字节；
- `test` 不接受 renderer 提供的正文或队列，只能向已经启用的队列提交内建固定测试票，并要求
  preload 固定确认字面量。

不得增加 generic invoke/fetch/shell、任意 `lp` 参数、任意文件读取或 Server claim/receipt 投影。
Web Settings 只是上述窄能力的操作者界面，浏览器宿主没有该端口。

### 3. 配置切换与签名派发串行化

启动和每次配置都先验证队列，再创建签名运行时。切换时先拒绝未安装的新队列，再停止旧
controller；`stop` 等待正在执行的轮询、CUPS 提交或回执上传结束，随后原子保存新选择并启动新
controller，不允许两个队列同时领取任务。启动失败时保留明确的 `unavailable` 配置并保持不领取
新任务，不能静默回退到别的队列。

每次 claim 前还会重新验证已选队列。队列消失时任务留在 Server 的 `queued`，不得先领取再把
外设缺失结算成业务打印失败。挂起/恢复继续使当前连续性 token 失效；持久 ledger 和待上传回执
继续由 ADR-20 约束。

### 4. `uncertain`、重试与补打语义不变

CUPS 返回可追踪 job id 只证明字节被 spool 接收，不证明纸张、内容或切刀。提交超时、进程中断
或无法确定 job id 时仍结算为 `uncertain`，重启绝不自动重复。柜台必须醒目提示“可能已经出纸”，
由操作者检查纸张后显式执行既有 `print.ticket.retry`；该命令重新读取当前权威事实并创建新任务。
只有 `done` 才能执行既有 `print.ticket.reprint`，补打同样创建新任务。不得把状态原地改回 queued。

### 5. 软件门禁与 XP-58 实体证据分层

软件动态验收使用注入的假队列发现、假 CUPS 提交和假 signed runtime，覆盖首次 bootstrap、配置
持久化、A→B 串行切换、非法/已移除队列拒绝、admin IPC、固定测试票、重启恢复以及
`uncertain` 人工重试提示。它不得调用真实 `/usr/bin/lp`，输出必须明确为 fake/software evidence。

XP-58 仍是独立外部门禁：在目标 Mac 安装真实 CUPS 队列后，以打包 App 和真实订单触发
enqueue→签名 claim→ESC/POS→CUPS→签名 receipt，记录 job id；现场核对中文、全角人民币金额、
CODE128 扫码、走纸、撕纸/切刀、断连不重复及显式补打恰好一份，并运行
`printer-acceptance:mac --job-id` 生成 `0600` 私有记录。照片只能使用合成数据并去除 EXIF，不能
提交顾客资料或原始队列标识。上述证据未齐前不得宣称 XP-58 或正式小票实体验收完成。

## 后果

- 打包柜台 App 可安全完成设备本地 CUPS 发现、选择、停用和显式固定试打，不再依赖操作者修改
  启动环境。
- 打印配置不会污染租户业务设置、命令冻结清单、Server API、数据库或 Runtime.app 权限面。
- 外设缺失在 claim 前失败关闭，动态切换不会制造双 controller；已开始的派发仍优先完成确定
  回执或保留 `uncertain`。
- 软件自动化可以证明控制流与防重复，但不能替代目标 XP-58、纸张、扫码和正式签名发布证据。

## 否决的备选

- **把队列写入 `platform.settings` 或 PostgreSQL**：设备拓扑不是租户业务事实，且会错误扩展
  命令/同步/离线面，否决。
- **renderer 直接执行 `lp/lpstat` 或传 raw bytes/path/argv**：形成任意本机执行与数据外带能力，
  否决。
- **切换队列时立即取消活动 controller 或自动重试 uncertain**：可能造成重复出纸，否决。
- **以固定测试票、fake CUPS 或 CUPS job id 关闭实体门禁**：不能证明纸面结果，否决。
