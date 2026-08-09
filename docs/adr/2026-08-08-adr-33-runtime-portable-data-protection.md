# ADR-33：Runtime 定时备份与加密换机数据包

- 日期：2026-08-08
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-29：Runtime 托管备份与恢复](2026-08-08-adr-29-runtime-managed-backup-restore.md)、[ADR-30：Runtime 发布、升级与受控回滚](2026-08-08-adr-30-runtime-release-upgrade-rollback.md)、[ADR-32：Runtime 托管 LAN 运维](2026-08-08-adr-32-runtime-managed-lan-operations.md)
- 影响：Runtime.app、LaunchAgent、备份留存、加密导出/导入与换机恢复

## 背景

ADR-29 已交付可验证的 PostgreSQL + 照片一致性备份和原机恢复，但仍依赖人工触发，也没有
面向外部介质和新 Mac 的加密携带格式。直接复制 Runtime 私有目录会把实例权威、数据库凭据、
设备密钥和运行状态一起复制，既不安全，也会让两台机器误认为自己是同一实例。

本片只处理本地定时保护和操作者显式换机；不引入云备份、后台上传、跨版本数据推断或 HTTP/
Electron/AI 数据导入面。

## 决策

### 1. 定时任务只创建并验证 managed backup

Runtime 安装第二个 LaunchAgent：固定 label `com.laundry-desk.runtime.maintenance`、固定 argv
`[Runtime executable, maintenance]`、每天 03:00、无环境变量，stdout/stderr 指向
`/dev/null`。任务与手工备份、恢复、升级、LAN 使用同一 maintenance lock。

一次成功 maintenance 必须先在私有 staging 创建 `scheduled` 备份，完整验证数据库、照片、
manifest、大小与 SHA-256，再原子发布并更新 `maintenance-state.json`。失败只记录稳定错误码，
不删除旧有效备份；诊断和 GUI 显示超过 26 小时未成功、发现损坏或本次失败。

自动留存只处理已经验证的 `scheduled`：保留最多 30 份且不超过 30 天，并永远保留最新一份
有效备份。manual、pre_restore、pre_upgrade、pre_rollback、pre_transfer 和任何损坏项均不
自动删除。候选先原子移入私有 `backup-trash` 并 fsync，再有界删除；崩溃后只续删已入 trash
的条目，不能把半删目录当备份。

### 2. 便携格式使用分块认证加密

便携文件扩展名为 `.laundry-transfer`。密码仅从 SwiftUI `SecureField` 或 CLI stdin JSON 获取，
长度 12–256 UTF-8 bytes；不得进入 argv、环境、日志、状态或输出。密钥通过系统
CommonCrypto PBKDF2-HMAC-SHA256 派生，16-byte 随机 salt，轮次由本机约 250ms 校准并限制在
600,000..5,000,000；导入拒绝范围外参数。

主体使用 CryptoKit AES-256-GCM 的固定 1 MiB 分块。文件头绑定版本、KDF/AEAD、轮次、salt、
nonce 前缀、分块大小、明文总长和块数；每块 nonce 由前缀与单调块号组成，AAD 绑定完整头、
块号和明文长度。导入严格拒绝重排、重复、截断、追加、错误长度、错误 tag 与超过 128 GiB；
错误密码和密文损坏统一返回 `RUNTIME_TRANSFER_INVALID`。

明文 payload 是固定长度字段，不解包任意 tar 路径：严格 transfer manifest、`database.dump`
字节和 `photos.tar` 字节。manifest 精确绑定 source instance、export id/time、被导出 managed
backup manifest 及摘要、两项大小/摘要、release、migration head、schema 与两个 OCI image。

### 3. 导出/导入只走严格外部路径和原生维护入口

导出只能读取已验证 managed backup；GUI 通过 NSSavePanel，CLI 通过 stdin 提供规范绝对路径。
目标使用 `O_EXCL|O_NOFOLLOW`、`0600`、单链接同目录临时文件，流式写入并 fsync 后原子发布，
绝不覆盖现存文件。

导入通过 NSOpenPanel/stdin 打开普通单链接文件，读前/打开/读后核对 inode、mode、size、mtime、
ctime，并在私有 `transfer-staging` 完整解密、验证格式与摘要；此阶段不停止服务。全部通过后：

1. 停止 Server，创建并验证 `pre_transfer` 安全点；
2. 仅在 source/target release、migration head、schema 和 OCI image 完全相同时恢复 DB/照片；
3. 运行 roles/migrate/strict verify，成功后启动 Server；
4. 目标实例 id、卷标签、Runtime secret、Keychain 和设备密钥保持目标机器原值。

普通 restore 继续拒绝不同 instance；只有专用 transfer import 可显式接收不同 source instance。
开始改写数据后的任一失败保持停服，保留安全点、staging 和有阶段的恢复状态；重启 diagnose
必须报告确定 phase，不得静默启动半恢复数据。

### 4. CLI 与支持面

新增固定入口：`maintenance`、`transfer export`、`transfer inspect`、`transfer import`。transfer
命令的路径、密码和确认摘要均只从至多 4096 bytes 的 strict stdin JSON 读取；输出只包含无敏感
摘要、大小、兼容性和 `TRANSFER-<sha256 前12位>` 确认码。Counter、Web、Fastify、LAN、AI 和
支持包不获得 dump、导入、任意文件或密码能力。

### 5. 验收

- PBKDF2 known-answer 与跨块往返；错误密码、头/密文/tag 篡改、重排/重复/截断/追加和非法参数
  全部失败关闭，峰值内存只与单块和固定缓冲相关。
- 31 份 scheduled、过期、损坏、各种 safety/manual 类型与 trash 崩溃恢复证明留存规则。
- 路径相对/符号链接/硬链接/覆盖/目录替换、fsync/rename 前后崩溃和容量不足均无半成品冒充。
- 无仓库、PATH 无 Node/pnpm 的两个独立 Runtime 根完成 export/import；目标 instance 不变，源
  PostgreSQL 行、照片摘要与审计一致，密码不出现在进程 argv、runner log 或输出。
- 真实 source/destination 容器卷覆盖成功、pre_transfer 回退、坏 dump/photo/manifest、并发锁、
  低空间与各恢复 phase 崩溃；验收后精确清理所有隔离资源。

## 后果

- 店主获得无人值守本地保护与明确的加密换机路径，且不会复制运行时身份或设备权威。
- 第一版只支持完全相同的发布/schema/image；跨版本迁移必须先在源或目标按 ADR-30 升级，不在
  导入过程中猜测兼容性。
- 没有云端副本、外部介质耐久性或第二台真实 Mac 证据时，只能宣称本机软件门禁通过。

## 否决的备选

- **复制整个 Runtime 私有目录或 Docker volume**：会复制实例身份和秘密，否决。
- **密码放 argv/env 或写进 Keychain 后自动导出**：扩大泄密与无人值守解密面，否决。
- **单次把整个备份读入内存再 AES-GCM**：容量无界，否决。
- **损坏备份自动删除**：会毁掉唯一可人工救援证据，否决。
- **导入时自动跨版本迁移或覆盖目标实例 id**：兼容性和双主风险不可控，否决。
