# Windows Counter 打包

在 Windows 构建机执行，从真实提交的干净源码和同一提交生成的 Runtime entry 开始。
保留 `LAUNDRY_WINDOWS_BUILD_GIT_SHA`、`LAUNDRY_WINDOWS_RUNTIME_ENTRY` 和发行 profile 的现有门禁。
Runtime 准备流程见 [`tools/windows-runtime/README.md`](../../../tools/windows-runtime/README.md)。

```powershell
pnpm.cmd install --frozen-lockfile
# 先设置上述同源构建参数；profile 为 generic 或 hongfa。
pnpm.cmd --filter @laundry/edge-agent package:win
pnpm.cmd --filter @laundry/edge-agent package:inspect:win
```

`package:win` 与 `release:update:win` 先调用 `electron:prepare:win`。该步骤在
`electron-builder.yml` 指定的根依赖目录执行锁定 Electron 包的 `install.js`，固定 Windows x64，
使用包内 checksums，再检查 `path.txt`、发行版本和实际 Electron 进程报告的版本、平台、架构。
已就绪的相同版本可以重复准备；失败会阻止后续打包。首次准备需要能访问官方发行下载，或已有
可通过校验的下载缓存。只检查构建输入时可单独运行：

```powershell
pnpm.cmd --filter @laundry/edge-agent electron:prepare:win
```

Electron 42 的 npm 包提供 `install-electron` 命令，但没有 postinstall。
`pnpm install --frozen-lockfile` 与 `pnpm rebuild electron` 本身不会创建缺失的 Electron binary；
不能据此认定 Counter 的构建输入已齐全。

Windows CI 在打包前运行准备器的缺失二进制/失败退出回归，以及真实 ASAR 的 Runtime 配对回归。
ASAR 内部提取路径使用宿主平台分隔符，避免 Windows 把存在的 `runtime-binding.js` 误判为缺失。
完整的打包检查、安装验证、业务验收仍需分别通过；准备成功不代表运营准入。

两种安装器实际安装校验完成后，可用
[`package-delivery.mjs`](../../../tools/windows-runtime/README.md#聚合完整-windows-交付目录)
与配套 Runtime 聚合完整交付目录。该工具读取来自可信构建记录的安装回执摘要，核对源码、
发行 profile、Runtime 绑定及安装器字节；输出中文操作说明、发行索引与 `SHA256SUMS`。
它不会重新执行安装，也不会把开发候选改成已获准运营的发行版。

普通店员安装态专项使用 `pnpm --filter @laundry/edge-agent runtime:staff:win`。
执行器须先绑定实际安装的 EXE、同源合成 Runtime 和普通权限 Windows 会话，并设置
`LAUNDRY_WINDOWS_STAFF_ACCEPTANCE=synthetic-isolated`、`LAUNDRY_WINDOWS_INSTALLED_EXE`、
`LAUNDRY_WINDOWS_RUNTIME_SECRETS_DIR` 与全新绝对路径 `LAUNDRY_WINDOWS_STAFF_EVIDENCE_FILE`。
该专项验证双人复核创建/重置店员、收衣入口、管理查询与维护入口拒绝，以及旧凭据失效；
证据仅记录计数与布尔值，不等同于完整权限矩阵。测试枚举和静态检查不能替代实机执行。
