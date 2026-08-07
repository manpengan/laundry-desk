# ADR-29：Runtime.app 管理的本地备份与恢复

- 日期：2026-08-08
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-21：本地 Server 与 PostgreSQL 由独立 macOS Runtime.app 管理](2026-08-01-adr-21-independent-macos-runtime-app.md)
- 影响：macOS Runtime.app、本地 PostgreSQL/照片卷、灾难恢复验收

## 背景

仓库脚本已有开发态备份恢复，但 Finder 启动的 Runtime.app 脱离仓库、pnpm 与宿主 Node，当前
界面只有安装和生命周期控制。要求店主进入仓库执行命令不属于可交付恢复路径；把恢复放进
柜台 Electron、Owner LAN 或 AI 又会破坏 ADR-21 的权限隔离。

## 决策

### 1. 备份恢复只由原生 Runtime.app 管理

Runtime.app 增加“创建备份、列出托管备份、验证、恢复”操作。柜台 Electron、Owner Web、
Fastify API、命令总线与 AI 都不新增备份或恢复入口。该能力是本机操作者的 R5 维护操作，不
改变 39 条业务命令和 25 条查询冻结面。

### 2. 只接受 App 私有目录内的自有备份

备份写入 Runtime 私有数据根下固定 `backups/`，目录为 0700、文件为 0600。标识、文件名、
Compose project、卷名、容器和 argv 都由程序固定生成；不接受任意导入路径、shell 文本、
符号链接、硬链接或外部归档。

每个备份包含 PostgreSQL custom-format dump、照片归档和严格 manifest。manifest 绑定实例、
运行时/Server/schema 版本、创建时间、文件大小与 SHA-256；任何缺失、越界、哈希不匹配、
实例不符或未知版本都失败关闭。标准输出、日志和诊断不得包含数据库内容或秘密。

### 3. 恢复有确认、预恢复点和故障闭环

恢复前必须重新验证所选托管备份并要求操作者输入该 manifest 的确认摘要。流程固定为：

1. 停止 Server 写入；
2. 自动创建并验证预恢复安全点；
3. 在单事务中恢复 PostgreSQL并执行兼容迁移/校验；
4. 恢复照片卷并校验；
5. 启动 Server，验证 `/health`、schema 与实例身份。

中途失败不得删除原备份或预恢复点；界面显示稳定阶段和恢复指引，且 Server 不得在未通过
一致性检查时静默恢复服务。所有容器操作使用固定 argv 和已钉摘要镜像，不经 shell。

### 4. 资源与留存有界

运行器必须把 dump/archive 以流式文件处理，禁止把数据库或照片装入内存或现有 16 KiB 诊断
缓冲。单次只能运行一个维护任务；超时、磁盘空间、文件数量和备份尺寸在开始前及处理过程中
检查。首期不自动删除备份，操作者可在私有目录外另行复制；删除与外部导入后续另附设计。

### 5. 验收边界

- Swift 单元测试覆盖路径、权限、哈希、实例/版本、确认、并发和失败阶段；
- 真实 PostgreSQL + 照片卷完成“写入基线 → 备份 → 改写 → 恢复 → 逐项核对”，并注入损坏
  manifest/dump/photo 负测；
- 构建 ad-hoc arm64 Runtime.app，在仓库外临时目录完成无仓库/no-pnpm 恢复验收；
- `Laundry Desk.app` 仍不获得 Compose 或恢复权限。

本片不宣称 Developer ID、公证、正式 manifest 签名权威、多架构 OCI、换机分发或实体打印
已经完成，这些继续作为独立发布/硬件门禁。

## 后果

- ADR-21 的 `recover` 仍只表示中断安装恢复；数据恢复使用独立、明确的 backup/restore 操作。
- 维护权威留在原生主机应用，浏览器攻击面和业务命令冻结面不增长。
- 操作者必须保管导出的备份副本；自动轮换、云备份、加密外部介质与跨实例迁移后置。

## 否决的备选

- **由 Electron 或 Owner Web 调用 Compose**：破坏 ADR-21 权限隔离，否决。
- **新增 HTTP 恢复 API**：把 R5 主机维护暴露给浏览器，否决。
- **允许选择任意 dump/tar 路径**：引入路径、归档和实例混淆攻击面，否决。
- **仅恢复数据库或仅恢复照片**：会产生不可证明的一致性状态，否决。
- **恢复失败后自动删除安全点或继续启动**：可能掩盖数据损坏，否决。
