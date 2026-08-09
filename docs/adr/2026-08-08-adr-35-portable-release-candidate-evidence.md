# ADR-35：可携带正式候选证据与离线验证权威

- 日期：2026-08-08
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-30：Runtime.app 发布、升级与受控回滚](2026-08-08-adr-30-runtime-release-upgrade-rollback.md)、[ADR-34：设备本地 CUPS 配置与 XP-58 实体验收边界](2026-08-08-adr-34-device-local-cups-printer-configuration.md)
- 影响：正式 macOS 候选、OCI 发布证据、第二台 Mac 与 XP-58 现场验收

## 背景

Counter 与 Runtime 已分别具备签名发布入口，软件门禁也能覆盖无仓库运行、真实容器恢复和
打印派发，但这些结果来自不同时间、不同机器与不同信任根。把终端输出、截图或一组没有共同
权威的哈希放在同一目录，并不能证明它们属于同一 Git 提交和同一产品版本；软件测试更不能
替代 Developer ID、公证、公开 OCI、第二台干净 Mac 或 XP-58 实体出纸。

正式候选需要一个能复制到另一台 Mac、脱离仓库和开发工具后仍可独立判定的证据对象，同时
必须让缺失的外部条件保持可见，而不是由测试密钥或人工说明补成“通过”。

## 决策

### 1. 发布证据与现场证据分成两个独立必需层

候选包固定包含两个严格、拒绝未知字段的双签信封：

1. `release-evidence.json` 绑定精确 Git SHA、`clean=true`、产品版本，Counter 与 Runtime
   的 App 规范树、DMG、ZIP 和各自签名 manifest，Server/PostgreSQL OCI 原始 index JSON，
   真实容器换机恢复报告，以及本包原生验证器；
2. `field-evidence.json` 绑定前一层 authority 的 SHA-256，并分别绑定第二台干净 Mac 报告
   与 XP-58 实体验收记录。

两个 authority 都必须由 Counter 更新权威和 Runtime manifest 权威的 Ed25519 私钥分别签名。
私钥只以 0600、单硬链接、无符号链接的绝对路径进入组装进程，不写入参数、环境输出、候选包
或日志。验证端只从已签名 Counter/Runtime App 资源中提取对应公钥。

正式判定必须同时存在并验证两层；只完成 release 层可用于现场采集，但不得输出正式候选通过。
缺第二台 Mac 或 XP-58 任一报告时，不允许用 `null`、豁免、截图说明或软件测试记录占位。

### 2. authority 绑定原始字节而非标签

- 普通文件绑定相对路径、字节数和 SHA-256；App 绑定排序后的相对路径、类型、权限、文件
  字节摘要与安全相对符号链接形成的规范树；
- Counter 的更新 manifest 必须由其 App 内公钥验签，并与候选 DMG/ZIP 的名称、大小和摘要
  一致；Runtime manifest 必须由 Runtime App 内公钥验签，并与候选版本和 OCI 摘要一致；
- Server 与 PostgreSQL 的 `sha256:` digest 必须等于各自 OCI index JSON 的**原始字节**摘要；
  index 还必须含唯一 Linux amd64/arm64 描述，Server 两个架构摘要与 Runtime manifest 一致；
- 真实容器报告绑定同一 Git、版本和两个 OCI 摘要，并明确两个实例根、数据库/照片摘要及
  `cleanup=clean`；XP-58 继续复用 ADR-34 的签名派发/回执与七项人工确认记录。

JSON、路径和文件读取均有大小/深度边界；拒绝未知或缺失字段、非规范候选信封、符号链接逃逸、
硬链接、特殊文件、路径穿越、读取期间变化以及额外包条目。失败只返回稳定错误码，不输出路径、
命令原文、异常对象、证书内容、密钥或报告正文。

### 3. 正式验证器是 universal 原生 App

`Laundry Desk Release Candidate Verifier.app` 同时包含 arm64 与 x86_64，不在运行时依赖
仓库、Node、pnpm、PATH 或当前目录。它使用系统 Foundation/CryptoKit 完成严格 JSON、哈希、
规范 App 树和 Ed25519 验证；正式编译路径还必须：

1. 验证自身 Developer ID 签名、Gatekeeper 与 stapled notarization ticket，取得自身唯一
   `TeamIdentifier`；
2. 对 Counter/Runtime App 运行 `codesign --deep --strict`、`spctl` 和 `stapler validate`，
   并要求 bundle id、版本及 `TeamIdentifier` 与自身一致；
3. 对两个 DMG 运行 Gatekeeper 与 stapler 检查，再完成所有候选字节、manifest、OCI、报告
   与双签 authority 的离线复核。

系统命令使用绝对路径、固定参数、空环境和有界输出。正式二进制没有跳过 Apple 检查或接受
测试信任根的运行参数。

### 4. 测试构建永不升级为正式证据

只有以编译期 `RUNTIME_TESTING` 构建的验证器才允许 ad-hoc App、生成的测试 Ed25519 密钥和
假 fixture；其 assembler authority、现场报告与最终输出必须统一标为 `software_only`。
正式构建不包含该分支，并拒绝 `testing`、`ad-hoc`、`example`、`placeholder` 或
`software_only` 证据。测试包即使所有篡改负例和无仓库验收全绿，也不等于正式候选。

### 5. 外部证明边界

本 ADR 交付的是可执行的组装与验证机制，不声明当前已经取得下列材料：

- 同一 TeamIdentifier 的三份 Developer ID Application 签名与 Apple 公证/staple；
- 正式 Counter/Runtime Ed25519 私钥授权和非示例公开更新源；
- 已发布且可回取原始 index 的 Server/PostgreSQL 多架构 OCI；
- 第二台无仓库 Mac 的 Gatekeeper/启动/升级恢复记录；
- XP-58 中文、金额、条码、走纸、切刀、断连与显式补打实体验收。

任一材料未提供或校验失败，正式 assembler/verifier 必须非零退出。不得把 CI、fake runner、
ad-hoc 包、未公证包或人工待办描述为上述外部证明。

## 后果

- 发布、容器和现场证据第一次由同一 Git/版本与两套既有发布权威交叉绑定，可复制到第二台
  Mac 离线重验；单个文件、App 公钥、OCI index 或报告被替换都会破坏摘要或签名。
- Counter 与 Runtime 的既有发布 manifest 继续是各自更新链权威；候选信封只做交叉组合，
  不把其中一把私钥提升为另一产品的单方发布权威。
- 正式候选成为外部证据齐备后的动作；仓库内能持续完成的是 `software_only` 同构验收和
  fail-closed 回归。
- 本 ADR 不新增业务命令、HTTP/IPC、云部署或 Windows 能力。

## 否决的备选

- **只签一个总 manifest**：一把权威泄露即可替换 Counter 与 Runtime 全部证据，否决。
- **只保存 ZIP/DMG 哈希**：不能证明安装 App、公钥、OCI 与现场报告来自同一候选，否决。
- **验证器使用 Node 脚本**：第二台 Mac 需要开发运行时且 PATH/cwd 可改变行为，否决。
- **缺实机证据时输出 warning 但返回成功**：会把软件绿灯升级成正式发布结论，否决。
- **把测试开关做成正式二进制运行参数**：可在现场绕过 Apple 与信任根检查，否决。
