# Windows 形态可行性 findings 与局域网构建机操作手册

> 状态：**待 Codex 采纳**（2026-08-29）
> 主责：Claude（非阻塞复审角色，见 [CLAUDE.md](../../CLAUDE.md)）；**本文不构成裁决**
> 交付对象：Codex（阶段 5 owner，见 [AGENTS.md](../../AGENTS.md)）
> 触发：manpengan 提出「后面要开发 Windows 版本」，先行搭建实机环境并取证

本文两部分：**§1–§2** 是可直接使用的 Windows 构建机与 SSH 操作手册；**§3–§7** 是在该实机上跑出来的
Windows 移植阻塞点证据。§8 给出对设计的影响判断与 ADR 建议。

---

## §1 摘要

在同局域网 Windows 10 实机上完成环境搭建并跑通到测试层，结论如下。

| 项 | 结果 | 深度 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | ✅ 49.1s，退出码 0，无 node-gyp 编译 | — |
| `pnpm workspace:typecheck` | ✅ 12/12 任务，1m50.7s，退出码 0 | — |
| `@laundry/edge-agent` 脚本测试 | ❌ 61 项：33 通过 / 23 失败 / 5 跳过 | 见下 |
| **A. 目录 `fsync` 返回 `EPERM`** | ❌ 17 项失败 | **架构级，需 ADR** |
| **B. POSIX `0600` 权限不变量不可满足** | ❌ 5 项失败 | **架构级，需 ADR** |
| C. 脚本层 POSIX 命令替换 | ❌ 3 个 `test` 脚本 | 浅层，可直接修 |
| D. 无 `win` 打包目标 + 守卫测试禁止 | 静态扫描 | 设计闸门，需 ADR |
| E. 打印链路平台绑定 | 静态扫描 | **比预想乐观**，见 §7.2 |
| F. `safeStorage` 在 Windows 降级为 DPAPI | 静态扫描 | 安全属性变化，需 ADR 记录 |
| （非缺陷）Mach-O 检查测试 | 1 项失败 | macOS 专属测试，属预期 |

**一句话**：类型层完全干净，依赖层无原生模块负担；真正的阻塞在**持久化与权限这两个 POSIX 假设**上，
它们是 durable / 签名更新链路的设计前提，不是可以打补丁绕过的实现细节。

---

## §2 构建机与 SSH 操作手册

### 2.1 机器与接入

```
主机      DESKTOP-MAN   192.168.1.84   （与 Mac 同网段 en0 192.168.1.0/24）
系统      Windows 10 家庭中文版  build 19045 (22H2)
硬件      i7-11800H / 23.7 GB RAM / C: 剩余 114 GB
用户      74997
仓库      C:\dev\laundry-desk
工具链    node v22.22.3   pnpm 11.15.0   git 2.55.0.windows.5
```

Mac 侧 `~/.ssh/config` 已配好别名，直接用：

```bash
ssh winbox
```

公钥 `~/.ssh/id_ed25519_windows_lan`，已写入 Windows 端
`C:\ProgramData\ssh\administrators_authorized_keys`（管理员组用户**不读** `~/.ssh/authorized_keys`，
这是 Windows OpenSSH 的常见坑）。

`scp` / `sftp` 可用。注意：MSI 安装的 OpenSSH 默认 `sshd_config` 里 `Subsystem sftp sftp-server.exe`
是相对路径，sshd 服务解析不到会导致 `scp: Connection closed`。已改为绝对路径
`"C:/Program Files/OpenSSH/sftp-server.exe"`，备份在同目录 `sshd_config.bak`。

### 2.2 三个反直觉的坑

**① SSH 会话自带完整管理员令牌。** `IsInRole(Administrator)` 返回 `True`，不需要 UAC 提权技巧，
可直接写 HKLM、装 MSI、改服务。

**② PowerShell 执行策略是 `Restricted`。** `npm` / `pnpm` / `corepack` 在 PowerShell 里会解析到
`.ps1` 外壳并被安全策略拦截，报错内容还会被序列化成 CLIXML 乱码，极具迷惑性。**必须用 `.cmd` 外壳**：

```
npm.cmd    pnpm.cmd    corepack.cmd    git.exe
```

更稳妥的做法是构建命令直接走 `cmd.exe` 而非 PowerShell，避免 stderr 被 CLIXML 污染：

```bash
ssh winbox "cd /d C:\dev\laundry-desk && pnpm.cmd workspace:typecheck"
```

**③ 出海流量默认全断。** GitHub、`registry.npmjs.org`、gitea 自建远端、winget 源、Windows Update
**全部超时**，且表现为静默卡死数分钟而非报错——`Add-WindowsCapability` 和 `winget` 在这台机上
基本不可用，都依赖被墙的源。

已装 Clash Verge 2.5.2 并由 manpengan 配置订阅。**TUN 透明模式**下一切正常且**无需**给 node / git /
electron 单独配代理（实测直连 github 5.0s、npmjs 0.87s；反而 `127.0.0.1:7890` 不通）。
**Clash 未启动时，任何联网步骤都会卡死。**

### 2.3 装软件的可靠姿势

因 §2.2③，包管理器不可用。可靠流程是**在 Mac 侧下载 → 校验哈希 → 经局域网送达 → 静默安装**：

1. Mac 上 `curl` 下载，并与上游发布的校验值比对（Node 有 `SHASUMS256.txt`，
   Git for Windows 在 release notes 正文里给 SHA256）
2. 用一次性 HTTP 服务经局域网送达，或 `scp` 直传（**含凭证的文件必须走 scp，不要走明文 HTTP**）
3. Windows 侧 `Get-FileHash` 复核后再安装：
   - MSI：`Start-Process msiexec.exe -Wait -ArgumentList '/i', $path, '/qn', '/norestart'`
   - Inno Setup（Git）：`/VERYSILENT /NORESTART /NOCANCEL /SP-`
   - NSIS（Tauri 系）：`/S`

安装后 PATH 变更**不会**进入已有 SSH 会话（sshd 服务启动时已固化环境）。不要重启 sshd（有把自己
锁在门外的风险），改为每次从注册表刷新：

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```

若确需重启 sshd，用 SYSTEM 身份的计划任务触发，使其脱离当前会话进程树：

```powershell
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -Command "Start-Sleep -Seconds 3; Restart-Service sshd -Force"'
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'ld-restart-sshd' -Action $a -Principal $p -Force
Start-ScheduledTask -TaskName 'ld-restart-sshd'
```

### 2.4 在无外网条件下把仓库送过去

不依赖 GitHub / gitea，直接从 Mac 推 bundle（首次已用此法完成，HEAD 与 Mac 逐位一致）：

```bash
git bundle create /tmp/laundry-desk.bundle --all
scp /tmp/laundry-desk.bundle winbox:C:/dev/laundry-desk.bundle
ssh winbox "cd /d C:\dev && git.exe clone -b main C:/dev/laundry-desk.bundle C:/dev/laundry-desk"
```

clone 完记得把 `origin` 改回真实远端（bundle 会被登记为 origin）。

### 2.5 中文输出与引号转义

SSH 会话默认 GBK 代码页，中文输出乱码。用 `-EncodedCommand` 一次性解决编码与三层引号转义
（ssh → cmd.exe → powershell）：把脚本前置
`[Console]::OutputEncoding=[Text.Encoding]::UTF8`，转 UTF-16LE 后 base64，再
`powershell -NoProfile -EncodedCommand <b64>`。

### 2.6 刻意未做的两件事（留给 manpengan 裁决）

均属安全设置，本文不代为变更：

- **Defender 实时防护开启且零排除项**，会显著拖慢 `pnpm install` 与 electron-builder
- **执行策略 `Restricted`**，人工在该机敲 `npm` / `pnpm` 会被拦

### 2.7 已知限制

- **家庭版不能作 RDP 主机**。需要看 GUI 走 RustDesk；且 RustDesk 控制的是物理控制台会话，
  断开不锁屏，比 RDP 更适合跑 headed 的 Playwright/Electron 测试
- **CLAUDE.md 的「Windows 实机 60fps」门禁无法远程验收**。RDP 与 RustDesk 都会改变合成路径与
  实际帧率，远程观感不能作为证据，必须现场看物理屏或外部录像计帧

---

## §3 已验证通过的部分

- `pnpm install --frozen-lockfile`：**49.1 秒，退出码 0**。全程无 node-gyp 编译，
  证实 `apps/edge-agent` 仅依赖 `iconv-lite` / `zod`，**Windows 侧不需要 VS Build Tools**
  （仅根目录冻结的 v1 链路因 `better-sqlite3` 才需要）
- `pnpm workspace:typecheck`：**12/12 任务成功，1m50.745s，退出码 0**。整个 monorepo
  在 Windows 上类型检查完全干净
- Electron 41.10.3 正常落地

---

## §4 阻塞点 A：目录 `fsync` 在 Windows 上是 `EPERM`（17 项失败）

### 现象

```
error: 'EPERM: operation not permitted, fsync'
  async fsyncDirectory       (apps/edge-agent/scripts/sync-spa.mjs:288)
  async ensureBundlesRoot    (:333)
  async installBundle        (:448)
  async withPublicationLock  (:559)
```

### 根因

POSIX 下 `fsync()` 一个目录 fd 是把**目录项**持久化的标准手段，是「先写临时文件 → rename → fsync 父目录」
这套崩溃安全原子发布的基石。Windows 不支持把目录当文件句柄刷盘，`FlushFileBuffers` 对目录句柄返回
`EPERM`。

**注意区分粒度**：**文件级** `fsync` 在 Windows 上完全正常（33 项通过的测试即为证据），
失效的**只有目录级**。

### 影响面

三份独立实现，共 16 个调用点：

| 位置 | 调用点数 |
| --- | --- |
| [`apps/edge-agent/scripts/sync-spa.mjs:281`](../../apps/edge-agent/scripts/sync-spa.mjs) | 11 |
| [`apps/server/src/print/file-spool.ts:155`](../../apps/server/src/print/file-spool.ts) | 2 |
| [`apps/server/src/photo/file-store.ts:109`](../../apps/server/src/photo/file-store.ts) | 3 |

三份实现形态一致：`open(dir, O_RDONLY)` → `handle.sync()`。

失败的 17 项集中在 `syncSpa` / `checkSpa` 的持久化发布套件（测试 39–59），
测试名本身即在断言崩溃安全语义，例如：

- `syncSpa makes the bundle durable before committing the manifest pointer`
- `syncSpa leaves the complete A pointer readable when the process crashes before manifest commit`
- `syncSpa serializes concurrent publishers with one cross-process lock`

### 为什么不能简单跳过

`if (process.platform === 'win32') return;` 能让测试变绿，但等于**在 Windows 上静默放弃崩溃安全保证**，
而这套代码（`durable-json-file`、dispatch ledger、publication lock、queue file-store）整体设计都
建立在该不变量之上。Windows 上要取得等价保证需走 `MoveFileEx` + `MOVEFILE_WRITE_THROUGH` 语义，
属于重新设计持久化契约，不是补丁。

---

## §5 阻塞点 B：POSIX `0600` 权限不变量在 Windows 上不可满足（5 项失败）

### 现象

```
3 × 'update private key must be one bounded 600 file'
1 × 'release input must be one bounded 600 file'
1 × 'file bytes, relative path, mode, and symlink target are hash inputs'
```

### 根因

[`apps/edge-agent/scripts/release-resources.mjs:91`](../../apps/edge-agent/scripts/release-resources.mjs)
的 `readReleaseInputFile` 强制 `mode === 0o600`，并在打开前、打开后、读完后**三次复核**以防 TOCTOU
——是写得很扎实的安全检查。

但 NTFS 用 ACL 而非 POSIX 权限位，Node 在 Windows 上的 `stat().mode` 只反映只读属性：
可写文件恒为 `0o666`，只读文件为 `0o444`，**永远不可能是 `0o600`**；`fs.chmod` 在 Windows 上
也只能切换只读位。该检查在 Windows 上**结构性不可满足**。

第三项失败（`mode` 作为哈希输入）是同一根因的另一种表现：把权限位纳入内容哈希，
在 Windows 上必然与 macOS 算出不同结果。

### 影响面

`0o600` 在 `apps/edge-agent` 内广泛用于安全敏感文件（12 处以上）：设备私钥、授权信任存储、
运行时状态、release bundle、durable JSON、cups worker 状态。守的是**签名更新链路**，
即 ADR-13 的安全更新流程。

### 判断

这不是「Windows 上放宽检查」就能了事的。要么在 Windows 上改用 ACL 表达等价约束
（检查文件 DACL 仅授予当前用户与 SYSTEM），要么明确接受 Windows 上该不变量降级并写入威胁模型。
**两条路都需要 ADR 裁决。**

---

## §6 阻塞点 C：脚本层 POSIX 依赖（浅层）

仓库未设 `shellEmulator`，pnpm 在 Windows 上经 `cmd.exe` 执行脚本：

| 位置 | 问题 |
| --- | --- |
| `apps/edge-agent` / `apps/web` / `packages/ui` 的 `test` | `node --test $(find dist -name '*.test.js')` |
| 根 `runtime:app:lint:swift`、`release:candidate:swift:check` | `xcrun` / `swiftc`，纯 macOS |

`$(...)` 在 `cmd.exe` 中是字面量；更糟的是 Windows 的 `find.exe` 是**在文件中搜索字符串**的工具，
与 Unix `find` 参数完全不兼容。

**建议修法**：改为 `node --test "dist/**/*.test.js"`（Node 22 的 `--test` 原生支持 glob），
或在 `pnpm-workspace.yaml` 开 `shellEmulator: true`。Swift 相关脚本需要 Windows 对应实现或明确
标注为 macOS-only。

---

## §7 静态扫描发现

### 7.1 无 `win` 打包目标，且有守卫测试主动禁止

[`apps/edge-agent/electron-builder.yml`](../../apps/edge-agent/electron-builder.yml) 只有
`mac: target: dir`，`package.json` 只有 `package:mac`。

关键：[`apps/edge-agent/scripts/hash-app.test.mjs:242`](../../apps/edge-agent/scripts/hash-app.test.mjs)
与 `:260` **主动断言**配置与 `package:mac` 中不得出现 `windows|nsis`：

```js
assert.doesNotMatch(builderText, /dmg|notari|publish|windows|nsis/iu);
```

即新增 Windows target 会同时红掉一条守卫测试。这是设计闸门而非疏漏，**放宽范围须与 ADR 同步**。

### 7.2 打印链路：比预想乐观

初判「打印在 Windows 上功能为零」**需要修正**。代码里存在两条并行路径：

| 路径 | 组成 | 平台状态 |
| --- | --- | --- |
| 设备直写 | [`print/usb-port.ts`](../../apps/edge-agent/src/print/usb-port.ts) → `executor.ts` / `printer-smoke.ts` | **已支持 win32** |
| 签名派发运行时 | `cups-process` → `cups-worker` → `signed-executor` → `runtime.ts` | 仅 darwin |

[`usb-port.ts:203`](../../apps/edge-agent/src/print/usb-port.ts) 已有完整 `win32` 分支
（校验 COM / LPT / USB 设备路径），`:316` 按平台切换打开标志（Windows `r+`，
POSIX `O_WRONLY | O_NOFOLLOW`）。

而 [`main.ts:57`](../../apps/edge-agent/src/main.ts) 生产环境接的是第二条，
[`print/runtime.ts:36`](../../apps/edge-agent/src/print/runtime.ts) 与
[`cups-worker.ts:189`](../../apps/edge-agent/src/print/cups-worker.ts) 非 darwin 直接抛错。

**结论**：Windows 要补的不是整条打印链路，而是**在 `signed-executor` 接缝上做一个 Windows worker**，
复用既有 ledger / dispatch controller / 签名校验，把出口从 CUPS 换成 `usb-port` 或 Windows 打印后台。
工作量与 ADR 边界都比重写小得多。

### 7.3 `safeStorage` 在 Windows 上降级为 DPAPI

[`main.ts:154`](../../apps/edge-agent/src/main.ts) 起用 `safeStorage` 保护三样东西：
设备私钥、队列 KEK、授权信任存储。
[`safe-storage-device-keys.ts:217`](../../apps/edge-agent/src/pairing/safe-storage-device-keys.ts)
的注释写着「macOS Keychain backed」。

Windows 上 Electron `safeStorage` 走 **DPAPI**，`isEncryptionAvailable()` 返回 true，代码可运行，
但安全属性不同：DPAPI 绑定 Windows 用户账户，**无 OS 级授权提示，以该用户身份运行的任何进程都能解密**；
macOS Keychain 至少有 ACL 与提示。

对一个存放设备签名私钥的库而言这是实质性降级，不是注释过时。需在 ADR 中明确接受或另行设计。

---

## §8 对设计的影响与 ADR 建议

**建议新增一份「Windows 形态」ADR**，一次性裁决以下六项（按 ADR-16「契约面新增须附 ADR」）：

1. **持久化契约**（§4）——Windows 上目录级持久化如何取得与 POSIX 等价的崩溃安全保证，
   或明确降级范围。这是最深的一项
2. **权限不变量**（§5）——`0o600` 在 Windows 上以 ACL 表达，还是接受降级并写入威胁模型
3. **密钥保护**（§7.3）——接受 DPAPI 威胁模型，还是在 Windows 上另设方案
4. **打印出口**（§7.2）——确认在 `signed-executor` 接缝做 Windows worker 的方向
5. **打包与守卫**（§7.1）——新增 `win` target，同步放宽 `hash-app.test.mjs` 守卫断言范围
6. **目标 OS 版本策略**——本机为 Windows 10 22H2，已过微软支持期。是只保 Win11，
   还是继续兼容 Win10，需产品裁决

**可不经 ADR 直接修**：§6 的脚本层 POSIX 依赖。

**另需注意**：根 [`.github/workflows/build.yml`](../../.github/workflows/build.yml) 虽跑在
`windows-latest`，但那是**冻结的 v1 链路**（npm + electron-vite + better-sqlite3 + NSIS，
且为 `workflow_dispatch`），与 pnpm/turbo 的 V2 monorepo 不是同一条流水线，不可直接复用。

---

## §9 复现方式

```bash
ssh winbox
```

```
cd /d C:\dev\laundry-desk
pnpm.cmd install --frozen-lockfile
pnpm.cmd workspace:typecheck
cd apps\edge-agent
node --test scripts/*.test.mjs > C:\dev\test-scripts.txt 2>&1
```

完整测试输出留在构建机 `C:\dev\test-scripts.txt`。

失败项按根因归类：

- **17 项**目录 `fsync` `EPERM`（测试 39–59 区间的 syncSpa/checkSpa 持久化套件）
- **4 项**`0600` 权限不变量（测试 27、28、29、30）
- **1 项**`mode` 作为哈希输入（测试 5）——与上一类同源
- **1 项**`release inspection rejects a thin nested Mach-O and binds app identity`（测试 31）
  ——Mach-O 是 macOS 二进制格式，该测试**本质上是 macOS 专属**，不属移植缺陷
