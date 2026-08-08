# ADR-30：Runtime.app 发布、升级与受控回滚

- 日期：2026-08-08
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-21：本地 Server 与 PostgreSQL 由独立 macOS Runtime.app 管理](2026-08-01-adr-21-independent-macos-runtime-app.md)、[ADR-29：Runtime.app 管理的本地备份与恢复](2026-08-08-adr-29-runtime-managed-backup-restore.md)
- 影响：macOS Runtime.app、签名 release manifest、本地数据安全点、发布验收

## 背景

Runtime.app 已能脱离仓库安装、维护和恢复本地 Server/PostgreSQL，但只能在同一 manifest 下
恢复中断安装。继续要求操作者删除配置根或进入仓库执行脚本，会把正式升级变成不可审计的
人工迁移；只替换 App 而不约束 Server 镜像、schema 和回退目标，则可能让旧程序读取不兼容
数据，或让已修复的安全版本被重新安装。

## 决策

### 1. 发布描述与运行数据分离

Runtime.app 构建产物必须同时包含 `arm64` 与 `x86_64`，发布编排只接受固定参数与显式的
Developer ID、公证 profile、可信 manifest 公钥及输出目录。release manifest 继续使用独立
Ed25519 权威签名，固定绑定 Runtime/Server 版本、双架构 OCI 摘要、迁移集合、schema 上限和
唯一回滚目标；密钥内容不得进入 argv、环境、日志或仓库。

无正式证书时允许用临时测试密钥和 ad-hoc 签名验证同构流程，但不得把它报告为 Developer ID、
公证、Gatekeeper 或正式镜像发布证据。

### 2. 升级先冻结写入并创建一致性安全点

`upgrade --manifest <absolute path>` 只接受有界普通文件。Runtime 在同一 maintenance lock 内：

1. 验证候选签名、App/契约版本、Compose 摘要和多架构镜像元数据；
2. 要求候选版本高于当前版本且不低于本机记录的历史最高已接受版本；
3. 要求候选的 `rollback_target` 精确绑定当前 release、Server image 与兼容 schema 上限；
4. 停止 Server，创建并重新验证 PostgreSQL + 照片的 `pre_upgrade` 安全点；
5. 以候选摘要拉取镜像，执行 roles/migrate/verify/health 全门禁；
6. 只有全部成功后才切换当前 manifest、state 与 release history。

升级期间私有目录保存单一严格 transition 权威，完整绑定切换前后 state、签名 manifest、
release history、previous manifest、当前 phase 与安全点。任何普通 start/stop/backup 在
transition 未清除时均失败关闭，不得绕过未完成的版本切换；升级或回滚进程重启后，Runtime
会在普通严格加载前校验 transition，并从绑定的安全点恢复切换前稳定版本。迁移或健康门禁失败
时同样自动恢复旧版本；自动恢复也失败时保持停服并返回稳定 recovery-required 错误。

### 3. 回滚只允许签名授权的一步目标

回滚不接受外部路径、版本号或镜像参数，只能读取当前已验证 manifest 中的唯一
`rollback_target` 和私有目录保存的上一 manifest。操作者必须通过 stdin 提交精确
`ROLLBACK-<target release>` 确认；Runtime 在操作前再创建 `pre_rollback` 当前状态安全点。

首期回滚通过恢复 `pre_upgrade` 一致性安全点回到上一 release，因此会把升级后新产生的数据
留在 `pre_rollback` 安全备份中，而不会悄悄把新 schema 数据交给旧版本。完成回滚后仍保留
历史最高已接受版本；重新升级只能回到该版本或更高版本，不能借回滚链继续向更旧版本降级。

### 4. 验收与外部门禁分开

- Swift lint/编译与无仓库验收覆盖 N→N+1、错误目标、schema 不兼容、迁移失败自动恢复、
  显式一步回滚、错误确认、历史安全下限，以及升级/回滚每个元数据原子写边界的进程中断恢复；
- release 工具覆盖 universal 架构、严格配置、manifest 签验、命令编排和失败清理；
- 正式发布仍必须在外部补齐 Developer ID Application、公证、staple、正式 Ed25519 权威、
  可访问的双架构 OCI index，以及第二台无仓库 Mac 的安装和真实 N→N+1 演练。

本 ADR 不扩大柜台 Electron、Owner LAN、Fastify API、业务命令总线或 AI 权限面；云部署、
Windows 与实体打印仍按现有路线后置或独立验收。

## 后果

- Runtime 升级/回滚成为原生主机维护能力，不依赖仓库、pnpm、shell 或浏览器权限。
- 数据安全优先于无损降级；需要保留升级后数据时，应先修复新版本或重新升级后恢复
  `pre_rollback` 备份，而不是让旧二进制直接读取未知 schema。
- 正式 release 凭据和镜像发布仍是外部交付条件，软件门禁全绿不能替代这些证据。

## 否决的备选

- **直接替换 App/镜像并继续启动**：无法证明 schema、镜像和数据一致，否决。
- **仅比较 SemVer，不保留本机最高版本**：允许已修复安全版本被签名旧包降级，否决。
- **允许任意 rollback manifest 或备份路径**：引入路径、实例与版本混淆，否决。
- **用旧程序直接读取升级后数据库**：现有迁移账本要求精确集合，且兼容声明不足以证明所有
  查询安全；首期改为恢复一致性安全点，否决无损直启。
- **把发布密钥放进 App、仓库或环境**：扩大泄露面，否决。
