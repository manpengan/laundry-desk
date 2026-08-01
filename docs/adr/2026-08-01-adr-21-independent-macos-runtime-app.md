# ADR-21：本地 Server 与 PostgreSQL 由独立 macOS Runtime.app 管理

- 日期：2026-08-01
- 状态：**Accepted**
- 决策者：manpengan
- 路线：[ADR-14：通用 V2 本地优先交付](2026-07-25-adr-14-generic-local-first-v2-delivery.md)
- 前序：[ADR-08：发布、桌面升级与支持](2026-07-19-adr-08-release-desktop-upgrade-lts-support.md)
- 影响：macOS 安装边界、Compose 拓扑、运行时清单、密钥与恢复

## 背景

开发仓库中的 `local:up` 能构建并启动 PostgreSQL/Server，但它依赖仓库、pnpm、源码目录和
repo-relative Compose 文件。Claude 产品规格 §3.3 同时明确：柜台 Electron App 只消费本地
loopback 服务，不负责安装、启动或停止 Docker Compose。把生命周期塞进 Electron 会让业务
壳拥有主机级容器权限，也会把“柜台打不开”和“数据服务无法恢复”耦合成一个故障域。

因此本地测试 App 要变成可交付产品，还缺一条 Finder 可操作、无仓库、无 pnpm 的独立运行
时链，并且必须防止 Server、数据库 schema 与柜台 App 各自升级后形成不可恢复的漂移。

## 当前交付边界（2026-08-01）

仓库已交付独立原生 arm64 Runtime.app 软件：固定 install/start/stop/restart/status/diagnose/
launchd 命令、同一签名 manifest 的中断安装恢复、私有 secret/volume 绑定，以及脱离仓库与
宿主 Node 的 native acceptance。测试产物只做 ad-hoc codesign，并使用临时测试签名 key 与
fake runtime runner。

尚未交付 Apple Developer ID 签名与公证、XP-58 实体打印证据、正式 manifest 签名权威，
以及已签名且可访问的多架构 OCI 发布物。`recover` 只恢复同一 manifest 的中断安装；当前
没有 Runtime.app upgrade/rollback 命令，也不得把 rollback 兼容元数据写成已实现回滚能力。

## 决策

### 1. 交付两个独立 App

- `Laundry Desk.app`：现有柜台 Electron 壳，只探测并访问固定 loopback Server。
- `Laundry Desk Runtime.app`：独立原生管理器，负责安装、start/stop/restart、健康诊断、
  登录启动和恢复指引。

两者不共享进程权限；Runtime 不向 renderer 暴露通用 shell，柜台 App 不调用 Compose。

### 2. 安装后不依赖仓库或 pnpm

Runtime.app 自带固定命令控制器、严格配置 schema、Compose 模板和可信公钥槽；release manifest
由外部提供且必须通过该公钥验签。正式生产签名权威尚未建立，仓库验收只使用临时测试 key。
运行数据位于用户专用的 `~/Library/Application Support/Laundry Desk Runtime/`，LaunchAgent
和诊断命令只引用安装后绝对路径。Compose 不含 `build:`、源码 bind mount 或 repo-relative
脚本，所有命令使用固定 argv，不拼接用户 shell 文本。

最低在线安装从 OCI registry 拉取多架构 Server 镜像和 PostgreSQL 16 镜像；离线 image tar
不是首期承诺，可在后续独立增加。

### 3. 运行时清单签名并钉死镜像摘要

Ed25519 签名 manifest 至少绑定 runtime semver、Server 与 Web 版本、contracts major、数据库
schema/migration 文件名及 checksum、Server 多架构 image digest、PostgreSQL 16 OCI digest、
最低兼容 App 和 nullable rollback 兼容元数据。Compose 只能消费 `image@sha256:...`；tag 仅
用于展示，不能作为执行权威。rollback 字段只约束元数据，不提供回滚执行入口。

当前安装与启动路径必须先验签、校验 digest 与兼容窗口；未知 schema、checksum 变化、低于
安全下限或缺失 manifest 一律停止并给出恢复指引，不能“先启动看看”。未来若实现升级或
回滚，也必须复用这些门禁并另行补充状态迁移与验收。

### 4. 密钥只经安全输入与私有文件进入服务

首次设置由 Runtime.app 的安全输入框采集；自动化/CLI 只接受有界 stdin 结构。管理员密码、
数据库密码和服务密钥不得进入 argv、宿主环境、日志、源码或 Compose 明文。Runtime 生成
0600 私有 secret files，以 Compose secrets / `*_FILE` 方式交给容器；Server 在进程内读取后
不回显。

已有数据卷但 secret、instance identity 或 manifest 绑定缺失/不匹配时必须失败关闭，绝不
静默新建数据库或回落内存模式。

### 5. 生命周期与恢复可观测

Runtime 提供固定的 install/start/stop/restart/status/diagnose/launch-at-login 操作。start 先
验证 Docker/Compose 外部依赖、清单、私有目录、secret、卷身份与版本，再启动 PG，等待就绪，
执行兼容迁移，启动 Server 并验证健康/version/schema；任一步失败都保留数据并报告首个真实
错误。

用户级 LaunchAgent 只调用安装后固定控制器。诊断包有大小上限并默认脱敏，不包含 secret、
令牌、顾客资料或完整数据库。当前 recover 只允许继续同一签名 manifest 的中断安装；未来
升级与回滚必须遵循 manifest 兼容窗口，不允许用旧二进制盲读新 schema。

### 6. 验收必须离开仓库

自动化把成品 Runtime.app 复制到临时安装位置，在另一个干净配置根执行安装、启动、重启、
故障注入和恢复；测试进程移除仓库路径与 pnpm 依赖。允许注入本地签名测试 manifest 和受控
容器 runner，但生产默认不接受测试签名或未钉摘要镜像。

## 后果

- Docker Desktop、OrbStack 或兼容 Compose runtime 是首期明确外部依赖；Runtime 会检测并
  指引安装，不会把它伪装成 App 内置能力。
- 正式分发仍需 Developer ID、公证、正式 manifest 签名权威和已签名且可访问的 OCI 多架构
  镜像；本地 ad-hoc 构建只能证明软件边界与无仓库生命周期，不能证明换机分发。
- Electron 更新与 Runtime/Server 更新成为两个清晰版本域，以签名兼容清单协调，而非互相
  猜测环境变量。
- 未新增业务命令或查询，`m2-freeze.test.ts` 清单不变。

## 否决的备选

- **Electron 启停 Compose**：违反产品边界并扩大业务壳权限，否决。
- **继续要求用户在仓库执行 pnpm local:up**：不是可交付 App，否决。
- **Compose 使用 latest/tag 或现场 build**：内容不可证明且无法可靠回退，否决。
- **把密码写进 `.env` 或启动参数**：会进入环境、进程列表或支持包，否决。
- **缺 PG 时静默启动 memory runtime**：可能造成整日数据丢失，否决。
