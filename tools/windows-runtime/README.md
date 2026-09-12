# Windows Runtime companion payload

本工具实现 [ADR-67](../../docs/adr/2026-08-30-adr-67-windows-native-local-runtime.md) 的独立运行文件打包
与无源码仓库加载验证，当前只产出 `development_only` payload。
它不是安装器，不创建数据库、凭据或计划任务，不允许作为宏发真实运营包。现有
`install-development-runtime.ps1` 仍是依赖构建机源码的开发工具。

## 构建

在 Windows x64 的 clean exact Git SHA 上，先安装锁定依赖；下载 `companion-sources.mjs` 中固定的
两个 HTTPS ZIP。Node 摘要来自官方 SHASUMS256；PostgreSQL 摘要来自官方 Windows 页面指向的 EDB
16.15-3 HTTPS 下载，记录于 2026-09-11，**不是上游数字签名**。

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd runtime:win:package --source-sha <40-hex-sha> --node-archive <node.zip> --postgres-archive <postgres.zip> --release 0.1.0-win-dev
```

构建器核对源码前后 clean SHA，以锁文件导出 hoisted production Server，验证上游 archive 摘要，
只提取 Node 可执行文件/许可证及 PostgreSQL bin/lib/share/许可证；ZIP 路径、类型和解压大小有界。
payload 包含同一 Server、原生依赖、Win32 helper、69 个既有迁移及契约/schema 摘要输入。
逐文件清单绑定整个 payload；链接、额外文件、空目录、硬链接、Windows 路径别名和错误 PE 架构均拒绝。

结果位于 `tools/windows-runtime/dist/runtime-<SHA>-<release>`；最后一行 JSON 含
`manifest_sha256`，必须通过可信的构建记录单独传递。清单内的自报摘要不能替代外部预期摘要。
检查器验证的是包的完整性，不是发布者签名或安装授权。

## 无源码仓库检查

把完整 payload 复制到仓库外的全新目录。使用已信任的 Node 运行检查器；首次执行包内 Node 前，
须先通过构建记录核对整个分发物摘要，不能先执行待验证的二进制来建立对自身的信任。

```powershell
node.exe <payload>\scripts\inspect-companion.mjs <payload> <manifest-sha256>
node.exe <payload>\scripts\smoke-companion.mjs <payload> <manifest-sha256>
```

smoke 的子进程使用包内固定 Node、仅含系统目录的 PATH 和受限环境；实际加载 Sharp/Argon2 原生模块，
调用同一 `migration-info` 并核对聚合摘要。通过只表示独立 payload 可加载，不代表数据库或柜台已安装。
Windows Server CI 与目标 Windows 10/11 零售 PC 的现场验收分别记录。

## 后续安装生命周期门禁

执行顺序与失败重入矩阵见
[Windows Runtime companion 后续交付计划](../../docs/superpowers/plans/2026-09-12-windows-runtime-companion-delivery.md)。

- 私有 DACL 根、版本目录、崩溃安全指针、安装/修复/停止/重启；
- 无源码仓库且无系统 Node/pnpm 条件下安装，卸载保留数据库和密钥；
- 同迁移跨版本升级/回滚，迁移变化时的备份与联合恢复；
- Authenticode 或获裁决的受控内部分发策略；
- 目标 Windows 10/11、中文 IME、150% DPI、三类打印机现场证据；
- ADR-65 独立生产候选、离机恢复、告警送达、容量与真实数据责任。

本批不会把这些未取得的证据记为通过。首次进入安装器实现前，按这些条件冻结安装状态机与失败重入
测试；不让 Electron 负责数据库生命周期。
