# Windows Runtime companion payload

本工具实现 [ADR-67](../../docs/adr/2026-08-30-adr-67-windows-native-local-runtime.md) 的独立运行文件打包
与无源码仓库加载验证，当前只产出 `development_only` payload。
包内新增独立安装生命周期入口，可创建合成数据库、私有凭据及登录任务，仍不允许作为宏发真实运营包。现有
`install-development-runtime.ps1` 仍是依赖构建机源码的开发工具。

## 构建

在 Windows x64 的 clean exact Git SHA 上，先安装锁定依赖；下载 `companion-sources.mjs` 中固定的
两个 HTTPS ZIP，以及 `companion-crt-source.mjs` 固定的 Microsoft x64 Redistributable。
Node 摘要来自官方 SHASUMS256；PostgreSQL 摘要来自官方 Windows 页面指向的 EDB
16.15-3 HTTPS 下载，记录于 2026-09-11，**不是上游数字签名**。

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd runtime:win:package --source-sha <40-hex-sha> --node-archive <node.zip> --postgres-archive <postgres.zip> --crt-archive <VC_redist.x64.exe> --release 0.1.0-win-dev
```

构建器核对源码前后 clean SHA，以锁文件导出 hoisted production Server，验证上游 archive 摘要，
只提取 Node 可执行文件/许可证及 PostgreSQL bin/lib/share/许可证；ZIP 路径、类型和解压大小有界。
payload 包含同一 Server、原生依赖、Win32 helper、该源码的完整迁移集及契约/schema 摘要输入。
逐文件清单绑定整个 payload；链接、额外文件、空目录、硬链接、Windows 路径别名和错误 PE 架构均拒绝。

构建时只用 Windows 内置 `expand.exe` 解开经固定摘要验证的 CAB，不执行 Redistributable 或 MSI。
完整的 12 个 x64 Visual C++ DLL 原样复制到 PostgreSQL bin 与 Argon2 原生模块目录；两组必须一致，
来源、版本、许可证及全部摘要由 `metadata/windows-crt.json` 和发行清单绑定。
安装不会写入系统目录或注册系统运行库。历史无 CRT payload 仍可检查；声明 CRT 的版本须携带完整一组，
回滚按该发行自身的来源和摘要验证，不把当前构建版本当作历史版本白名单。
发行权限须按 [Visual Studio 2022 许可](https://visualstudio.microsoft.com/license-terms/vs2022-ga-community/)
与 [REDIST 清单](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution) 核对；包内运行库许可证保留原始字节。

结果位于 `tools/windows-runtime/dist/runtime-<SHA>-<release>`；最后一行 JSON 含
`manifest_sha256`，必须通过可信的构建记录单独传递。清单内的自报摘要不能替代外部预期摘要。
检查器验证的是包的完整性，不是发布者签名或安装授权。

## 中文安装与维护入口

在同一可信构建记录上，为完整 payload 生成独立入口：

```powershell
node.exe tools/windows-runtime/package-runtime-entry.mjs --payload <payload-absolute-path> --manifest-sha <64-hex> --source-sha <40-hex> --output <new-absolute-directory>
```

分发目录包含 Laundry Runtime V2.cmd、固定绑定的 PowerShell 入口与完整 payload。
先核对可信构建记录的入口与发行摘要，再双击 CMD；界面无需手填发行摘要、源码路径或环境变量。
选择“安装本地服务”或“升级”后，私有 Programs 目录与开始菜单保留对应发行的独立维护入口；
升级保留旧入口，撤走原分发后仍可维护。柜台卸载不删除入口或数据库。

界面提供状态、启停、修复、跨迁移联合升级/回退、备份列表/验证/恢复、离机备份、定时维护、数据迁移/导出与中断维护恢复。
恢复仍要求明确选择一份备份并人工输入完整确认摘要；界面不会默认选择或自动填入确认。
这是 [ADR-69](../../docs/adr/2026-10-01-adr-69-windows-runtime-operator-entry.md) 的开发版入口，
当前只允许合成数据；照片、迁移和权限恢复均按可信清单验证，不满足约束时停止操作。

## 无源码仓库检查

把完整 payload 复制到仓库外的全新目录。使用已信任的 Node 运行检查器；首次执行包内 Node 前，
须先通过构建记录核对整个分发物摘要，不能先执行待验证的二进制来建立对自身的信任。

```powershell
node.exe <payload>\scripts\inspect-companion.mjs <payload> <manifest-sha256>
node.exe <payload>\scripts\smoke-companion.mjs <payload> <manifest-sha256>
```

smoke 的子进程使用包内固定 Node、仅含系统目录的 PATH 和受限环境；验证五个 PostgreSQL 核心工具
（具备备份能力时再验证 dump/restore）的实际版本，再加载 Sharp 并实际执行 Argon2 hash/verify，
调用同一 `migration-info` 并核对聚合摘要。通过只表示独立 payload 可加载，不代表数据库或柜台已安装。
Windows Server CI 与目标 Windows 10/11 零售 PC 的现场验收分别记录。

## 独立安装生命周期

先通过可信构建记录验证整个分发物和外部 manifest SHA，再执行包内入口：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <payload>\scripts\lifecycle-launch.ps1 -Action install -Payload <payload> -ManifestDigest <manifest-sha256>
```

启动脚本在 Node 执行前清除注入环境并验证 Node/脚本摘要；不要绕过该入口直接启动 Node。

同一入口支持 `status`、`stop`、`start`、`repair`、`upgrade`、`rollback`、`uninstall`。
`upgrade` 传入新完整包及其外部摘要；`rollback` 选择状态中保留的前一版本。
相同迁移按既有程序升级流程处理；迁移为可信追加且 PostgreSQL 版本一致时，按 ADR-80 先建立
程序/数据恢复点，在影子库执行新迁移并启动真实服务健康探测，再切换程序与数据库。
历史迁移被修改、缺失或 PostgreSQL 主版本不匹配时拒绝升级。跨迁移回退使用绑定的升级前快照，
回退前另存当前数据安全点，不能只替换程序目录。

安装根固定为 `%LOCALAPPDATA%\laundry-desk-v2\runtime-companion`。初始化时创建两个独立合成管理员，
凭据仅写入私有 `secrets` 下的 `laundry-bootstrap-admin-*` 与 `laundry-bootstrap-approver-*` 文件。
登录任务使用固定包内 Node，并读取持久化版本指针；无需源码、系统 Node/pnpm、Docker 或 WSL。

首次安装在创建状态、凭据和数据库前运行原生依赖预检；缺少 DLL 或工具版本不匹配时停止安装。

卸载必须从安装根之外的可信原始分发包执行，以免删除正在执行的 Windows 二进制。它保留数据库、
密钥与恢复记录；重装要求同一发行摘要，完成恢复验证后才启动。半初始化不会自动重建数据库。

软件证据与剩余边界见[生命周期记录](../../docs/operations/2026-09-13-windows-runtime-lifecycle-result.md)。

## 本机托管备份与恢复

[ADR-68](../../docs/adr/2026-09-30-adr-68-windows-managed-backup-restore.md) 增加原生维护入口。
操作前退出 Counter；沿用可信原始分发包、外部 manifest SHA 和同一 PowerShell launcher：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <payload>\scripts\lifecycle-launch.ps1 -Action backup -Payload <payload> -ManifestDigest <manifest-sha256>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <payload>\scripts\lifecycle-launch.ps1 -Action backup-list -Payload <payload> -ManifestDigest <manifest-sha256>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <payload>\scripts\lifecycle-launch.ps1 -Action backup-verify -Payload <payload> -ManifestDigest <manifest-sha256> -BackupId <b_32hex>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <payload>\scripts\lifecycle-launch.ps1 -Action restore -Payload <payload> -ManifestDigest <manifest-sha256> -BackupId <b_32hex> -ConfirmationDigest <backup-manifest-sha256>
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <payload>\scripts\lifecycle-launch.ps1 -Action maintenance-recover -Payload <payload> -ManifestDigest <manifest-sha256>
```

`backup` 返回 `backup_id` 和备份 `manifest_sha256`；确认摘要来自所选备份，与发行摘要是不同值。
托管目录在安装根的 `backups`，每份包含 custom-format dump、严格 manifest 及所引用的照片，使用受保护 DACL。
绑定实例、迁移、PostgreSQL 版本、大小与 SHA，不接受外部导入路径。恢复先创建安全点，在临时库
单事务导入并直接校验迁移账本与关键表，再以 OID 绑定的事务切换，避免残留恢复后多余旧表。

失败后先用 `status` 查看阶段，再明确执行 `maintenance-recover`。verified 之前回到原数据；
verified 之后完成已经验证的恢复。`safety_backup` 保留恢复前的数据，可另选并确认恢复。维护未
完成时，登录启动、普通启动/修复、升级/回滚和卸载不能绕过记录。原本停止的实例维护后保持停止。
未标记的临时库不会自动删除，结果会返回 `retained_shadow`。

单 dump 512 MiB、原库预检 2 GiB、托管备份含未完成目录最多 32 份。启用每日计划后，按明确
留存规则清理已校验且不被当前维护/回退记录引用的备份，至少保留最新两份；损坏或未知目录不自动清理。
Windows 私有照片能力已启用，数据库与照片共同验证/恢复；普通备份恢复仍要求相同迁移和 PostgreSQL 版本。
恢复保留当前密码、人员停用和角色状态，撤销旧会话/执行授权，AI 密钥和短信设置必须重新配置。
旧版已完成切换但没有撤权证明的中断记录保持停服，不能靠再次启动绕过。
当前版与登录 controller 必须都支持备份；旧 controller 返回 `BACKUP_CONTROLLER_UPGRADE_REQUIRED`，
需先按既有同迁移流程升级到新包，再保留数据卸载并以当前同一发行身份重装，不能手改任务或状态。
维护窗口另提供加密离机归档、换机导入、旧版迁移和整店业务/照片导出；口令和路径经有界 UTF-8
标准输入传给可信维护进程，不放在命令行。换机导入以可信当前模式逐字段恢复并撤销旧执行权。
这些软件能力已完成本地和隔离真库回归；完整 Windows 安装态、离机介质和真实运营准入分别验证，
见[本轮实施清单](../../docs/operations/2026-10-03-windows-full-feature-batches.md)。

## 后续现场与生产门禁

执行顺序与失败重入矩阵见
[Windows Runtime companion 后续交付计划](../../docs/superpowers/plans/2026-09-12-windows-runtime-companion-delivery.md)。

- 新维护功能在完整 Windows 安装态的程序/数据联合升级回退、照片、定时任务与离机归档证据；
- Authenticode 或获裁决的受控内部分发策略；
- 目标 Windows 10/11、中文 IME、150% DPI、三类打印机现场证据；
- ADR-71 后续本机生产准入 ADR、离机恢复、告警送达、容量与真实数据责任（Cloud 仍暂停）。

这些现场与生产证据不由 Windows Server CI 替代。Electron 继续不负责数据库生命周期。

2026-10-01 用户接续裁决：本轮专注 Windows 功能开发及测试，云平台开发部署已移出范围。
