# ADR-65：Cloud 生产基线、隔离环境与可恢复性门禁

- 日期：2026-08-25
- 状态：**Proposed**
- 决策者：待 manpengan 签署（已授权启动阶段 5.1 规划，尚未签署本决策细节）
- 前序：[ADR-43：Cloud 数据保护、离机副本与联合恢复](2026-08-12-adr-43-cloud-data-protection-and-joint-recovery.md)、
  [ADR-64：阶段 5 生产化接续与发布留存归档](2026-08-17-adr-64-stage5-productionization-and-release-retention.md)
- 5.0 证据：[阶段 5.0 发布解阻与关闭结果](../operations/2026-08-25-stage50-release-result.md)
- 执行草案：[阶段 5.1 Cloud 生产基线计划](../superpowers/plans/2026-08-25-stage51-cloud-production-baseline-plan.md)
- 影响：Cloud 环境权威、数据保护、离机介质、监控告警、容量门禁、事故回滚与阶段 5.2 准入

## 背景

阶段 5.0 已把 exact-main 维护树、完整 release-set 归档、留存余量和受保护发布工具部署到
hk-vps，并以 `c8919af3c666cf70df2fbf04645ebdf0f377f35a` 的新鲜 API/UI 与 preflight 证据关闭。
该环境仍按 ADR-36 标记为 `hk-vps-cloud-test`，只允许合成数据且可丢弃。

ADR-43 已交付 PostgreSQL + 私有照片恢复集、离机复制、周期演练、状态和联合恢复的软件面，但
真实网络存储 authority、systemd 安装、外部告警接收、容量和从离机副本恢复的远端证据尚未取得。
把当前测试站点直接改名为生产，或只安装 unit 就宣布完成，都会让测试身份、恢复失败域和真实数据
授权混在一起。

## 决策

### 1. 测试与生产候选必须是两个独立环境

`hk-vps-cloud-test` 保持合成数据 staging，不改名、不原地提升为生产。阶段 5.1 另建一个
production-candidate，至少独立拥有：

- 主机/虚拟机与固定 SSH host-key authority；
- DNS origin、TLS 身份、Caddy upstream 与公网边界；
- PostgreSQL cluster/database/roles、照片根、服务账号和运行秘密；
- release state/controller/backup/evidence、data-protection state 与本地恢复集；
- 离机目标 authority、监控标签和告警路由。

两个环境不得共享可写数据库、照片目录、服务秘密、release transition、恢复集或离机目标 marker。
生产候选的凭据、私钥、数据库 URL、接收端 secret 和客户数据不得进入 Git、argv、日志或验收证据。

仓库工具只能接受代码内固定 allowlist 与 root-private authority 共同确认的命名环境；不新增“任意
host/user/path”发布参数，不允许通过复制 hk-vps 私有状态建立生产候选。所有部署仍来自 clean
`main == origin/main` 的 exact SHA 与 required checks，不产生服务器私有补丁。

### 2. 5.1 的“真实”指真实基础设施，不要求真实顾客数据

阶段 5.1 全程继续使用可证明清理的合成数据。真实离机介质、真实告警接收端、真实容量和真实恢复
动作必须在实际 production-candidate/独立失败域上取证，但这不构成顾客 PII 授权。

只有 5.1 全部关闭、数据责任与访问人另行确认、并由阶段 5.2 明确批准后，生产环境才可导入真实
顾客数据。关闭 5.1 本身不等于单门店上线或生产 SLA 生效。

### 3. 数据保护沿用 ADR-43，并以离机副本为恢复真源验收

production-candidate 必须从同一 exact-main 安装 ADR-43 root-only runner 和 systemd units，继续
与发布共用 release lock。至少取得：

1. PostgreSQL + 权威私有照片的一致本地恢复集和创建时影子恢复；
2. 真实 `nfs4`、`cifs` 或 `fuse.sshfs` 独立挂载、有效 root-only authority、传输与静态加密证明；
3. 源恢复集与离机副本的完整 manifest/文件摘要复核；
4. 从**离机副本**读取的独立 drill；
5. 在隔离 recovery target 上执行一次完整 joint recovery，复核 code SHA、migration ledger、catalog、
   PostgreSQL 业务不变量、照片清单与服务健康；
6. 恢复前安全点、失败注入和恢复后清理证据。

日常目标为 `RPO ≤ 24h`、演练实测 `RTO ≤ 4h`。ADR-43 的 26 小时 backup/offsite 健康阈值是为每日
调度留出的容差，不放宽 RPO；8 天 drill 阈值继续有效。若真实演练达不到目标，5.1 失败关闭并在
调整目标或架构前另行裁决，不能修改证据使其变绿。

### 4. 监控必须证明外部送达

每 15 分钟执行的数据保护/服务状态、每日 backup/offsite、每周 drill 均进入环境独立的监控标签。
告警至少覆盖：备份/离机/drill 过期、维护或 release transition 卡住、服务/公网健康失败、磁盘容量
不足、恢复集损坏和 timer 失败。

关闭证据必须注入至少一个无数据破坏的阈值失败，证明从首次失败采样起在一个 15 分钟采样周期加
10 分钟传输预算内到达外部接收端，并记录接收端生成的无秘密 receipt id 与时间；随后证明状态恢复
和告警解除。systemd unit、journal、Prometheus 文本或“发送成功”日志不能替代接收端送达证据。
人工 24×7 值守和业务 SLA 属于阶段 5.2，不由本 ADR 冒充。

### 5. 容量以获批准的试点画像两倍负载验收

执行前冻结一份不含顾客数据的单门店试点容量画像，明确并发浏览器、读写动作、订单/顾客增长、
照片数量与大小、报表/导出、备份、发布和离机复制峰值；画像须在测试前由产品负责人确认，不能在
结果不佳后回改。production-candidate 按该画像 **2 倍负载连续 60 分钟**验收：

- 业务旅程零非预期失败、零 5xx、无 OOM、服务重启、failed unit 或持续 swap 增长；
- 应用 + PostgreSQL 稳态 CPU 与内存各保留至少 30% headroom；
- API/UI 延迟不超过画像预先冻结的阈值；
- 在 release peak、完整本地恢复集和一次 offsite staging 同时计入后，磁盘仍同时满足未来 30 天
  的画像增长量，以及 `max(总容量 20%, 16 GiB)` 的空闲余量；
- release、backup、offsite 与 drill 串行锁竞争符合设计，没有饥饿或越过维护窗口。

画像和原始聚合指标作为阶段 5.1 结果附件；不得记录请求体、顾客字段、凭据或数据库 URL。

### 6. 事故路径必须分别证明代码回滚与数据恢复

在 production-candidate 的合成数据上至少演练：

- 一个 same-migration 候选在外部验收失败后的 exact-identity 代码回滚；
- 一个进入数据改写后的 joint recovery，从获验证离机 set 恢复到隔离 recovery target；
- 回滚/恢复中断重入、应用 LOGIN/write gate、服务启动顺序与失败后保持安全状态。

代码回滚不得自动恢复数据库；联合恢复不得只换代码、只还数据库或只还照片。两条路径分别记录
数据损失窗口、开始/结束时间、恢复点身份、最终 marker/migration 和健康结果，不记录秘密或 PII。

### 7. 5.1 关闭条件

阶段 5.1 只有同时满足以下条件才可关闭：

- 本 ADR 由 manpengan 签署为 Accepted，外部主机、DNS/TLS、离机存储和告警接收端均已授权；
- production-candidate 与 hk-vps 测试环境通过独立 authority、状态、数据、秘密和失败域复核；
- 所需代码/运维变更合入 exact green `main`，并在生产候选完成 guarded deploy 与发布后验收；
- ADR-43 本地恢复集、真实离机副本、离机 drill 和完整 joint recovery 全部通过；
- RPO/RTO、告警送达/解除、两倍负载容量和事故代码回滚取得新鲜证据；
- runbook、容量画像、恢复记录、访问/数据授权边界和阶段结果已回写且不含秘密；
- 两个环境仍只含合成数据，真实顾客 PII 尚未导入。

任一外部依赖缺失时，状态必须精确保持 `blocked_external_environment`、
`blocked_external_offsite`、`blocked_external_alerting` 或 `blocked_external_capacity`，不能以
`software_only`、同机目录、journal 或测试站点证据替代。

## 理由

- 环境隔离使发布测试、恢复演练和真实数据责任不会共享一个可丢弃状态。
- 从真实离机副本完成联合恢复，才能证明备份是可运行的恢复介质，而不是同机文件存在证明。
- 接收端送达和故障注入把“有监控代码”提升为实际可发现事故的证据。
- 以事先冻结的两倍试点画像验收，既有明确余量，又避免用任意压测数字冒充容量规划。
- 先用合成数据完成破坏性演练，再在阶段 5.2 单独授权真实数据，缩小不可逆风险。

## 否决的备选

- **直接把 hk-vps 标为生产**：测试身份、数据和失败域未隔离，否决。
- **同盘目录或 bind mount 冒充离机**：无法抵抗主机/磁盘故障，否决。
- **只证明备份成功，不从离机副本恢复**：不能证明介质可用，否决。
- **以 journal 或发送端 2xx 冒充告警送达**：没有接收端证据，否决。
- **先导入真实 PII 再做恢复演练**：把未验证恢复路径施加于顾客数据，否决。
- **通用任意主机/路径发布 CLI**：扩大 root 远端写入面，否决。
- **5.1 同时接 provider、试点或桌面硬件**：外部依赖与事故面混杂，否决。

## 后果

- 5.1 会增加环境化 root-only 运维、部署证据和外部基础设施成本，但不新增产品 HTTP/IPC、
  Command/Query 或业务迁移。
- hk-vps 继续作为合成数据 staging；production-candidate 在 5.1 关闭前也不承载真实顾客 PII。
- 单节点 production-candidate 的通过不等于多地域 HA、24×7 人工值守或正式业务 SLA；这些与单店
  真实运行证据由阶段 5.2 决定。
- 真实 provider、桌面签名和硬件证据继续留在 5.3/5.4，不进入本阶段关键路径。
