# ADR-43：Cloud 数据保护、离机副本与联合恢复

- 日期：2026-08-12
- 状态：**Accepted**
- 决策者：manpengan（按 ADR-37 后续 1→5 顺序实现授权）
- 前序：[ADR-29：Runtime.app 管理的本地备份与恢复](2026-08-08-adr-29-runtime-managed-backup-restore.md)、
  [ADR-33：Runtime 定时备份与加密换机数据包](2026-08-08-adr-33-runtime-portable-data-protection.md)、
  [ADR-36：云测试环境](2026-08-09-adr-36-cloud-test-environment.md)、
  [ADR-37：Cloud Web-first 主交付线](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 影响：hk-vps 主机维护、PostgreSQL/私有照片、离机留存、监控、发布与灾难恢复

## 背景

hk-vps 两阶段发布已经在停写窗口创建 root-only PostgreSQL custom dump，并在同一集群的影子库
比较迁移账本与 catalog。该恢复点只包含数据库，且只服务一次发布 transition；它不包含
`/var/lib/laundry/photos`，没有周期恢复集、离机副本、数据保护健康状态，也没有把代码、迁移、
数据库和照片作为一个身份执行恢复的入口。

ADR-29/33 已为 macOS Runtime 冻结严格 manifest、数据库与照片一致恢复、定时维护和加密换机
边界，但它们的权威属于本地原生 Runtime.app。直接把 Runtime 私有目录或 Compose 操作搬到云端，
既不适配裸机 systemd/PostgreSQL，也不能证明 Cloud 数据已受到保护。

## 决策

### 1. 只有 root 主机维护面可操作数据保护

新增 Cloud 数据保护 runner，但不增加 HTTP、Fastify、命令总线、Owner Web、Counter、Edge 或 AI
入口。runner 仅以 uid 0 运行，并与发布控制器共用
`/run/lock/laundry-desk-cloud-release.lock`；备份、恢复、发布、迁移或留存核对不能并发。

固定主根为 `/var/lib/laundry-desk-data-protection`，本地恢复集位于 `sets/`，操作状态、最近成功
状态和监控快照均为 root-owned、0700/0600、单链接普通节点，经临时文件、fsync 和原子 rename
发布。拒绝任意 shell、任意数据库名、任意照片根、符号链接、硬链接、目录穿越和宽权限文件。

### 2. 恢复集绑定同一停写点的数据库与照片

一次备份固定执行：持久化维护 intent → 停止 Desk → 持久化并激活 `laundry_app NOLOGIN` 写门闩
→ 终止并复核应用连接 → 读取 live marker、迁移账本和 write-frozen catalog → 创建 custom dump
→ 读取 `garment_photos` 中有内容摘要的权威清单 → 逐个 `O_NOFOLLOW` 复制并核对大小/SHA-256 →
发布严格 manifest → 影子恢复验证 → 释放门闩 → 启动并验证精确 SHA 的 Desk。

服务停止和数据库门闩期间照片不会新增或换绑；恢复集只复制数据库引用的文件，不把 orphan 当成
业务数据复活。任一引用缺文件、摘要或大小不符都使整次备份失败；旧有效恢复集不删除。操作状态
在门闩前先落盘，崩溃恢复根据该状态释放 LOGIN 或保持服务停止，不能让“备份失败”静默留下永久
停服或半开写入。

恢复集 v1 精确包含：

- `database.dump`：PostgreSQL custom-format dump；
- `photos/`：ownership marker 与权威照片文件，均为 0600；
- `manifest.json`：schema/version、set id、环境、代码 SHA、migration head/count/ledger digest、
  source catalog digest、数据库字节/摘要和有界照片清单；
- `verification.json`：影子库迁移账本/catalog、照片清单与完成时间的独立验证结果。

manifest 和 verification 不包含数据库 URL、口令、token、cookie、PIN、照片内容或顾客字段。

### 3. 每份发布/周期恢复集必须经过影子恢复

备份发布前创建随机 `laundry_data_drill_<token>` 影子库，以单事务 `pg_restore` 恢复 dump，要求：

- 迁移账本与源库逐项一致；
- owner、ACL、RLS/FORCE RLS、policy、function 与 relation catalog 摘要一致；
- 影子库 `garment_photos` 权威文件清单与恢复集 manifest 一致；
- 恢复集里的每个照片文件再次通过大小和 SHA-256 校验。

影子库必须在成功或失败后删除；无法删除进入维护失败并保留可定位状态。周期恢复演练重新读取
已经发布的恢复集并重复上述过程，而不是只相信创建时的 verification。

### 4. 离机副本只接受可证明的网络文件系统目标

首期 provider-neutral 传输目标固定挂载到 `/mnt/laundry-desk-offsite`。复制前必须由 `findmnt`
证明该路径本身是独立网络文件系统挂载，fstype 仅允许 `nfs4`、`cifs` 或 `fuse.sshfs`，并要求
`rw,nodev,nosuid,noexec,nosymfollow`；源与目标不能是同一设备。目标根必须有独立 ownership
marker。复制过程固定并反复核对 staging 的设备号、inode 与 canonical path；源和目标文件都以
`O_NOFOLLOW` 打开，在同一文件描述符上复制、`fchmod`、摘要、`fsync` 与 `fstat`，摘要结束后还要
重新绑定目录项，最后原子发布并从目标重验整个恢复集及源 manifest 摘要。

远端账号、SSH/NFS/CIFS 凭据、链路加密、远端磁盘加密、不可变/对象锁与地理隔离属于部署证据，
不得写入仓库或 manifest。root-only、0600、单链接的固定 authority 文件必须严格绑定 target id、
规范化 mount source/fstype、非本机 failure domain、远端身份以及有界的签发/过期时间；loopback、
本机 failure domain、过期或与实际 mount 不一致都失败关闭。未取得并验证真实远端目标或 authority
时，软件只能标记 `software_only`，离机状态为 `blocked_external_offsite`，整体健康不得为真。

本地最多保留 8 个已验证 set，离机最多保留 30 个已验证 set；达到上限先失败关闭。首期不自动
删除任何恢复集，避免在尚无第二个已验证副本时由定时任务破坏最后救援证据。删除/归档另需显式
操作者授权和后续保留策略。

### 5. 状态、监控与告警判据是失败关闭的

维护状态分别记录 backup、offsite、drill、recover 的最近成功与最近失败；一个动作成功只能清除
自身失败，不能用昨日离机复制掩盖今日备份失败。失败证据若无法持久化则保留 operation 并失败
关闭，不能 catch 后清空状态。`status` 每次重新验证路径/权限、最近恢复集摘要、Desk/PostgreSQL
与 loopback 绑定，并按固定阈值判定：

- 最近成功备份不超过 26 小时；
- 最近离机验证不超过 26 小时；
- 最近独立恢复演练不超过 8 天；
- 没有活动/失败维护状态或 release transition；
- 服务健康、marker、migration head 与最近恢复集声明相容。

输出是无敏感字段的严格 JSON/Prometheus 数值，异常返回非零。systemd timer 可每 15 分钟执行
status、每日执行 backup/offsite、每周执行 drill；oneshot unit 使用只读系统、精确可写路径、
受限 proc/device/kernel 面和 10/30 分钟超时。真实 pager、邮件或监控平台接收和送达仍需外部
验收，不能用 unit 文件或 journal 记录冒充已告警。

### 6. 联合恢复绑定精确代码、迁移、数据库和照片

联合恢复只接受 runner 自己列出的 set id，并要求 stdin 提交 `RECOVER-<manifest SHA-256 前12位>`。
执行前必须重新验证恢复集和影子恢复、创建并验证当前状态的 `pre_recovery` 安全集，并在 `/opt`
中唯一定位 marker 等于恢复集 `code_sha` 的 root-owned retained code tree；不接受操作者任意路径。

恢复顺序固定为：保持 Desk 停止和应用 NOLOGIN → 准备目标代码副本 → 单事务清理/恢复
`laundry_v2` → 复核迁移账本/catalog → 在同一文件系统原子交换照片根 → 原子切换代码 → 释放
LOGIN → 启动并验证 marker、health、PostgreSQL/照片一致性。恢复后的代码、migration head、catalog、
数据库和照片必须与同一 manifest 完全一致。

开始改写后的任一失败保持服务停止、应用 NOLOGIN、`recovery_required` 状态与 pre-recovery set；
不得自动猜测跨版本迁移、只恢复数据库、只恢复照片或用新代码打开旧 schema。恢复/回退恢复状态
必须是显式后续动作并留下新证据。

### 7. 阶段与验收声明

软件完成至少需要：严格 parser/路径/权限/共享锁证明/状态单测，真实 PostgreSQL + 私有照片完成
backup → mutation → shadow drill → joint recovery，注入 dump/photo/manifest/权限/连接/启动失败，
以及定时/监控/未获 authority 离机路径的完整失败关闭。生产 dump 由 root 在私有 staging 打开
0600 文件描述符，再把 stdout 交给 postgres 身份的 `pg_dump`，不能要求 postgres 穿越 root-only
父目录。所有临时资源必须按精确身份清理。

真实 hk-vps 完成还需要：精确 main SHA/CI、安装 systemd units、真实网络挂载和加密/权限证据、
至少一次本机恢复集与离机副本、独立影子演练、一次受控联合恢复演练、监控阈值触发和实际告警
接收。未获得部署、远端存储或告警端授权时，这些保持独立 pending。

## 后果

- hk-vps 不再只能依赖 release-time database-only dump；数据库与私有照片可以形成同一身份的恢复集。
- 浏览器和业务服务不获得主机、dump、照片目录或恢复权威。
- 阶段 4.1 软件门禁通过仍不自动把 ADR-36 开发测试环境升级成生产 SaaS；容量、SLA、多地域、
  密钥托管和真实事故演练需要后续外部证据。
- 旧 release history 的 database-only 恢复点继续按原 manifest 验证，但不能冒充 ADR-43 恢复集。

## 否决的备选

- **继续把发布 dump 当完整备份**：缺照片、离机和周期演练，否决。
- **在线复制数据库目录或照片目录**：不能证明共同时间点且会复制不完整文件，否决。
- **新增 Web/HTTP 恢复按钮**：把 root 数据改写权威暴露给公网应用，否决。
- **复制整个 `/var/lib/laundry-desk` 或 server.env**：会带走实例状态与秘密，否决。
- **接受任意 tar/路径/远端命令**：引入路径穿越和命令注入，否决。
- **只测 pg_restore，不核照片和 catalog**：不能证明可运行的业务状态，否决。
- **恢复失败后自动启动或只切回代码**：会让旧代码读取未知 schema/数据，否决。
- **fake 网络目录冒充离机完成**：只能证明软件 adapter，否决完成声明。
