# ADR-69：Windows Runtime 普通用户安装与维护入口

- 日期：2026-10-01
- 状态：**Accepted**
- 决策者：manpengan（会话授权推进 Windows 安装与维护软件）；Codex 负责实现与门禁
- 前序：[ADR-66](2026-08-29-adr-66-windows-hongfa-pilot.md)、
  [ADR-67](2026-08-30-adr-67-windows-native-local-runtime.md)、
  [ADR-68](2026-09-30-adr-68-windows-managed-backup-restore.md)
- 影响：独立 Runtime 分发与中文维护界面；不新增业务 Command/Query

## 背景

Windows companion 已能脱离源码运行，但操作者需要自行提供 payload 路径与可信 manifest 摘要。
这不足以构成可双击的普通用户安装和维护入口，也容易把外部提供的摘要误当发行权威。
Counter 与 Runtime 生命周期独立；柜台 EXE 卸载后仍需保留可访问的恢复工具。

## 决策

### 1. 信任由可信构建写入入口

`package-runtime-entry.mjs` 接受可信构建的 payload、外部预期 manifest SHA 与 source SHA，先执行
完整 companion 检查。随后在清单外生成固定 sibling `payload` 的 PowerShell 入口、双击 CMD、
中文 WinForms 与安装辅助脚本及发行证据。manifest 不加入自身入口摘要，避免递归摘要依赖。

生成入口嵌入 source SHA、manifest SHA、全部 Node/脚本 bootstrap 的文件大小与 SHA，以及两个
operator 辅助脚本和 CMD 的大小与 SHA。运行时不接受 payload、source SHA、manifest SHA 的
参数、环境覆盖或可替换 sidecar。发行证据是供外部验证的记录，不是入口重新取得信任的来源。

入口本身仍需由可信发行渠道、外部入口摘要或后续 Authenticode 验证；包内自报摘要不能证明
发布者身份。当前保持 `development_only`，未签名内部受控分发政策与正式签名门禁独立记录。

### 2. 初始验证只依赖操作系统 .NET

在任何 payload Node 或未验证辅助代码执行前，入口清除注入环境，仅保留明确 OS 上下文和已选定
的合法 `Bypass` process 执行策略；不写机器或用户执行策略。自足 .NET 检查路径全部祖先无
reparse point、文件为唯一普通文件、大小有界及固定 SHA。目录链按 root 到 leaf 以 nofollow 句柄
固定；文件以 `CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT)` 取得同一验证和读取句柄。验证后的
manifest/bootstrap/operator 文件保持只读共享句柄直到动作结束，阻止验证后替换、删除或写入。

辅助脚本通过绑定校验后才 dot-source。每个真实生命周期动作继续调用原 launcher，后者及
lifecycle 对完整 payload、安装状态、进程/任务归属和维护记录执行既有检查。新界面不替代这些门禁。
子进程输出与错误有界；失败只展示稳定错误码，不输出凭据、连接串、私有文件内容或原生命令。

### 3. 独立普通用户程序目录

安装动作先把完整绑定分发安装到 `%LOCALAPPDATA%\Programs\Laundry Desk Runtime V2\<manifestSHA>`。
根与发行目录使用当前 SID、SYSTEM 和 Administrators 的受保护私有 DACL；新目录内按绑定逐文件
验证并复制，再发布目录。既有发行目录须完整匹配，额外文件、链接、篡改或快捷方式冲突拒绝覆盖。

每个发行在开始菜单和存在时的桌面建立独立快捷方式，指向系统 PowerShell 的固定入口参数。
发行目录不位于 Counter 或 `runtime-companion` 数据目录内；卸载 Counter 不删除 Runtime 程序入口、
数据库、凭据或备份。现有 Runtime 数据根、登录任务以及保留数据卸载规则不变。

### 4. 人可见的维护决策

WinForms 提供安装、状态、启停、修复、固定包同迁移升级/程序回滚、备份创建/查看/校验/恢复与
中断维护重入。严格 CLI 使用同一固定绑定，便于真实 Windows 和无源码验收。

恢复要求先明确选择托管备份 ID，再人工输入完整 64 位 manifest 摘要；不自动选择备份、不默认
填入确认摘要。备份选择变化清除确认输入，恢复另有显式确认。GUI 的启停/维护提示帮助操作者先
退出 Counter；维护并发、迁移兼容、实例绑定和恢复安全点仍由 ADR-68 执行路径裁决。

不同迁移联合升级、生产真实数据、Win11/重启/中文输入、实体打印机、正式签名、ADR-65 离机恢复、
告警与容量门禁仍独立验收。本 ADR 不以软件测试代替上述准入证据。

## 验证要求

跨平台测试覆盖固定 binding、完整 bootstrap、无清单递归、包篡改/source 替换拒绝、拒绝覆盖已有
目录以及恢复参数。Windows PowerShell 5.1 行为测试实际运行生成入口，覆盖环境清理、错误脱敏、
manifest/bootstrap/helper 篡改、硬链接/junction 拒绝、私有 Programs 安装及删除原分发后仍能调用入口。
测试使用显式合成 launcher，绝不执行合成 PE；真实 PostgreSQL、Session 1 WinForms 和源码撤走后
维护闭环由目标 Windows 验收单独提供。
