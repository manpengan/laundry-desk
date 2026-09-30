# ADR-68：Windows Runtime 本机托管备份与恢复

- 日期：2026-09-30
- 状态：**Accepted**
- 决策者：manpengan（会话选择 Windows Runtime 备份与恢复）；Codex 负责实现与门禁
- 前序：[ADR-29](2026-08-08-adr-29-runtime-managed-backup-restore.md)、
  [ADR-66](2026-08-29-adr-66-windows-hongfa-pilot.md)、
  [ADR-67](2026-08-30-adr-67-windows-native-local-runtime.md)
- 影响：Windows 原生维护入口、私有托管备份与恢复中断重入；不新增业务 Command/Query

## 背景

Windows companion 已有无源码安装、启停、同迁移升级/回滚和保留数据卸载，但没有数据恢复入口。
仅换回程序版本不能证明数据库也可恢复。目标 Windows 构建机暂不可连接，本片先实现软件路径，
以合成数据和 GitHub Windows Server CI 验证打包后的原生 PostgreSQL 恢复。

## 决策

### 1. 维护权威留在独立 Runtime

经过发行摘要核对的 PowerShell launcher 增加 `backup`、`backup-list`、`backup-verify`、`restore`
与 `maintenance-recover`，与所有生命周期动作共用同一内核锁。Electron、HTTP、业务总线与 AI
不增加恢复入口；不改变 loopback 拓扑、租户注入、业务权限、计价或审计。

当前版本与登录任务 controller 都必须携带完整备份能力。旧 schema-1 payload 仍可参与既有安装、
升级与回滚校验；不了解维护记录的旧 controller 不能取得新备份能力。controller 更新继续使用既有
保留数据卸载、以当前同一发行身份重装的流程，不暗中替换任务权威。

### 2. 只接受同实例的私有托管备份

固定根为 `%LOCALAPPDATA%\laundry-desk-v2\runtime-companion\backups`。标识由程序生成为
`b_<32 lowercase hex>`，每份仅含 `database.dump` 和严格 `backup.json`。不接受外部路径、额外
文件、符号链接、reparse point、硬链接或宽泛权限；复用 Win32 helper 的受保护 DACL、文件身份与
目录持久化检查。

manifest 绑定随机实例密钥的 SHA-256、发行身份、迁移头与聚合摘要、PostgreSQL 版本、创建时间及
dump 大小与 SHA-256。恢复另要求所选 manifest 的确认摘要。凭据、连接串和数据库内容不进入标准
输出、错误信息或 CI artifact；备份不包含 secrets。

首期仅覆盖当前 Windows 的 `disabled_empty` 照片形态：照片目录存在或照片表非空即阻断。备份与
当前 Runtime 的迁移头、聚合摘要和 PostgreSQL 版本必须一致，不自动迁移不足的备份。不同迁移的
程序/数据库联合升级、照片联合恢复、跨实例导入与加密外部导出仍另行交付。

### 3. 先验证临时数据库，再原子切换

先持久化 `maintenance.json`，禁用登录任务、停止 Server 写入并受控停库；维护期间仅启动数据库。
恢复固定执行：

1. 校验当前数据库，创建并验证恢复前安全点；
2. 持久化随机临时数据库名、原库 OID 和候选库 OID；
3. 通过保持打开且已验证的 dump 句柄，以 `pg_restore --single-transaction` 导入空临时库；
4. 直接校验完整迁移账本、关键表、初始化状态及照片为空，禁止通过迁移修补备份证据；
5. 在一个事务中保留改名后的原库，将候选库改名为 `laundry_v2`；
6. 再次校验当前库，持久化 verified 记录，然后按 OID 清理保留原库；
7. 受控停库、持久化 idle，再按维护前的运行状态启动服务并执行既有健康门禁。

原库保留到 verified 持久化；恢复前安全点始终保留。原生工具遵循 PostgreSQL 官方
[pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)、
[pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html) 和
[ALTER DATABASE](https://www.postgresql.org/docs/16/sql-alterdatabase.html) 语义。

### 4. 中断恢复以持久化记录与 OID 为准

维护未 idle 时，普通安装、修复、启动、升级、回滚和卸载被阻断；状态、停止与只读备份查看仍可用。
操作者明确执行 `maintenance-recover`，登录启动不能静默清除记录。

- verified 之前，按 OID 解析切换是否生效，必要时逆向切换，校验原库后恢复原运行状态。
- verified 之后，保留已经验证的数据，重入完成清理与启停；撤销恢复须另选安全点明确确认恢复。
- 创建候选库生效但尚未登记 OID 时，仅清理具有本操作标记的库；无标记库保留并返回
  `retained_shadow`，不把未知同名库认作可删除数据。
- 文件替换生效后报错、事务提交回执丢失、进程启动/停止失败都保留恢复证据，禁止继续未验证写入。

### 5. 资源与验收有界

单 dump 上限 512 MiB，原库预检上限 2 GiB；开始前核对空间，写入时监测大小与空间，原生流式进程
超时 10 分钟。托管备份含未完成目录最多 32 份，临时/保留数据库数量同样有界；首期不自动淘汰。

测试覆盖严格参数、权限/链接/身份、哈希、实例/版本/确认、留存、持久化失败和中断重入。真实
PostgreSQL 验证改写后的数据恢复、安全点、原始迁移账本拒绝、OID 混淆和切换恢复；Windows CI
在源码撤走、PATH 排除宿主 Node/pnpm 后运行原生完整路径。

目标 Windows 10/11 实机、中文输入、DPI、打印、签名及 ADR-65 真实离机恢复与数据准入继续独立
验收，当前发行保持 `development_only` 合成数据。
