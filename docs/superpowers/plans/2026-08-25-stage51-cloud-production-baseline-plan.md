# 通用 V2 阶段 5.1 Cloud 生产基线计划

> 日期：2026-08-25
> 状态：**规划已启动；待 ADR-65 签署与外部基础设施选择**
> 提案：[ADR-65：Cloud 生产基线、隔离环境与可恢复性门禁](../../adr/2026-08-25-adr-65-cloud-production-baseline.md)
> 前序裁决：[ADR-64](../../adr/2026-08-17-adr-64-stage5-productionization-and-release-retention.md)
> 已完成入口：[阶段 5.0 发布解阻与关闭结果](../../operations/2026-08-25-stage50-release-result.md)

## 1. 目标与当前基线

阶段 5.1 的目标是建立一个与 hk-vps 测试站点隔离、能够证明真实离机数据保护、告警送达、容量
余量和事故恢复的 production-candidate，为阶段 5.2 单门店受控试点提供准入证据。

当前已证明：

- hk-vps live 为 exact `main` `c8919af3c666cf70df2fbf04645ebdf0f377f35a`；
- migration 为 69/head `0069_bounded_automation.sql`，release transition 稳定；
- API 20/20、Cloud Chromium、四服务/共享站点、retention inventory/preflight 全部通过；
- `/opt=5`、history/controller/backup `=7/7/7`、evidence `=6`，下一次发布仍有一格余量；
- ADR-43 数据保护代码已在主干，但真实离机挂载、外部告警、生产候选和联合恢复证据仍未取得。

hk-vps 与未来 production-candidate 在 5.1 关闭前都只使用合成数据。

## 2. 推进规则

1. ADR-65 未签署前只做只读盘点、威胁/容量输入整理和计划评审，不实施生产主机变更。
2. 每一代码切片先有精确 ADR 边界、定向失败路径测试、`workspace-check`/真实 PostgreSQL，再经 PR
   合入 `main`；服务器不产生私有补丁。
3. 主机、DNS/TLS、离机挂载、告警接收端、恢复和真实数据均按精确对象单独授权；凭据不进 Git、
   argv、日志或证据。
4. 所有发布、数据保护与恢复共享同一环境 release lock；不并发运行 migration、backup、offsite、
   drill、recover 或 release-set archive。
5. 软件门禁、真实部署、离机介质、告警接收、容量、联合恢复和真实数据授权分别记账，不互相冒充。
6. 任一阶段失败都先保存安全现场并恢复或保持 write gate 的确定状态，不用手工 SQL/rename 绕过 runner。

## 3. 启动前待签署输入

| 输入                 | 最低要求                                                                          | 当前状态                       |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------ |
| ADR-65               | manpengan 对环境隔离、RPO/RTO、容量公式和关闭门禁书面签署                         | `pending_decision`             |
| production-candidate | 独立主机/网络、固定 SSH host key、服务与数据盘、责任人与费用授权                  | `blocked_external_environment` |
| DNS/TLS              | 与 test origin 分离的正式候选 origin 和可验证证书管理权威                         | `blocked_external_environment` |
| 离机介质             | 独立 failure domain 的 NFS4/CIFS/SSHFS，root-private authority、传输/静态加密证明 | `blocked_external_offsite`     |
| 告警接收端           | 独立于应用主机、能返回 receipt id/接收时间并可验证解除                            | `blocked_external_alerting`    |
| 试点容量画像         | 并发、业务动作、订单/照片增长、报表/备份/发布峰值和延迟阈值                       | `blocked_external_capacity`    |

这些输入缺失不阻止方案评审，但阻止任何“5.1 完成”或“生产可用”声明。

## 4. 固定执行顺序

### 5.1-A 裁决与基线盘点

- 签署 ADR-65，冻结 production-candidate、offsite、alerting 和容量画像的责任边界；
- 对 exact main 的 ADR-43 runner、systemd units、环境硬编码、固定路径和 SSH authority 做只读差距盘点；
- 形成命令/查询/迁移影响表；默认不改产品契约，若必须扩大则在同 PR 更新 ADR/CHANGELOG/验收记录；
- 建立只含非秘密标识的 evidence schema 和阶段结果模板。

关闭门禁：签署记录、外部对象精确 identity、差距清单和 PR 切片顺序齐全。

### 5.1-B 多环境发布与 root-only 运维边界

- 把仅支持 hk-vps 的发布/数据保护常量收敛为代码 allowlist 中的命名 profile；
- 每个 profile 固定 environment marker、origin、host authority、服务/数据路径和预期 TLS/loopback 边界；
- 拒绝任意 host/user/path、未知 profile、跨环境 marker/state/secret、非 clean main 和 CI 不绿；
- 补齐 parser、身份漂移、跨环境误连、输出脱敏、锁和回滚负向测试。

关闭门禁：定向测试、`workspace-check`、真实 PostgreSQL 和 exact-main required checks 通过；不修改
69 commands / 48 queries，除非另立并签署精确产品 ADR。

### 5.1-C production-candidate 建立与加固

- 以独立 authority 配置主机、DNS/TLS、Caddy、PostgreSQL、服务账号、照片/状态根和最小网络面；
- 应用与 PostgreSQL/KB 继续 loopback，公网只开放 TLS 入口；核对 owner/mode、systemd sandbox、
  firewall、时间同步、日志留存和安全更新策略；
- 从 exact green main 走 guarded prepare/finalize，以合成数据取得 API/UI、marker、migration、服务、
  shared-site 与 release retention 新鲜证据；
- 证明 test 与 production-candidate 无共享可写状态或秘密。

关闭门禁：独立环境身份、guarded deploy、健康/监听/TLS 和隔离报告全部通过。

### 5.1-D 真实数据保护与离机介质

- 安装并 `systemd-analyze verify` ADR-43 backup/offsite/drill/status units 与 timers；
- 创建 PostgreSQL + 私有照片本地恢复集并完成创建时 shadow restore；
- 核验真实网络挂载、独立 failure domain、root-only authority、加密与过期时间；
- 复制并从离机端重新验证完整 set，执行一次从离机副本读取的独立 drill；
- 注入坏 dump、照片摘要、manifest、权限、断连、容量和 lock 冲突，证明失败关闭且旧有效 set 保留。

关闭门禁：backup/offsite 均不超过 26h、drill 不超过 8d，真实离机 set 与负向证据齐全。

### 5.1-E 监控与外部告警送达

- 接入 service/release/data-protection/disk/timer 指标，环境标签与接收路由独立；
- 触发一个无破坏阈值失败，在 `15m + 10m` 预算内取得接收端 receipt；
- 恢复状态并取得解除/恢复通知；验证去重、重复失败、接收端暂时不可用和凭据脱敏；
- 明确 automated delivery 与人工 on-call/SLA 的分界。

关闭门禁：接收端 delivery/clear 证据和失败重试证据通过，journal 不作为送达真源。

### 5.1-F 容量与增长余量

- 由产品负责人冻结单门店画像和 API/UI 延迟阈值；
- 在 production-candidate 上以 2 倍画像连续 60 分钟运行合成业务；
- 同轮测量应用/PostgreSQL CPU、RSS、连接、队列、磁盘 IO、错误、延迟和照片/数据库增长；
- 叠加 release peak、本地恢复集与 offsite staging，验证 30 天增长和 `max(20%, 16 GiB)` 空闲余量；
- 在 backup/offsite/drill 与发布串行锁场景复测维护窗口。

关闭门禁：零非预期业务失败/5xx/OOM/restart/failed unit，CPU/内存至少 30% headroom，延迟和磁盘
公式通过；原始聚合证据可复算且不含请求体或顾客字段。

### 5.1-G 联合恢复与事故回滚

- 在合成数据上演练一次 same-migration 外部验收失败后的 exact-identity 代码回滚；
- 从真实离机副本恢复到隔离 recovery target，执行 code + database + photos 联合恢复；
- 注入一次恢复中断，证明 `recovery_required`、NOLOGIN、停服和精确重入；
- 核对 pre-recovery set、数据损失窗口、RPO `≤24h`、RTO `≤4h`、最终 marker/migration/catalog、
  照片摘要、API/UI 与服务健康；
- 受控清理所有合成 fixture、临时数据库和临时凭据。

关闭门禁：代码回滚与离机联合恢复各有独立 PASS 证据，任一失败不自动启动未知状态服务。

### 5.1-H 关闭与 5.2 准入

- 回写不含秘密的阶段 5.1 结果、runbook、容量画像、告警/恢复证据索引和已知限制；
- 重跑 exact-main required checks、远端 status/health、data-protection status 和 release preflight；
- 逐项核对 ADR-65 §7；
- 仅在全部通过后把 5.1 标为关闭，并另行请求阶段 5.2 的真实数据责任、单店范围与 SLO 裁决。

## 5. 证据矩阵

| 证据层      | 必须证明                                                     | 不能替代它的证据                          |
| ----------- | ------------------------------------------------------------ | ----------------------------------------- |
| software    | parser、权限、锁、失败路径、真实 PG/照片集成                 | 代码 review 或 fake adapter               |
| environment | 独立 authority/origin/data/secret/state 与 exact-main deploy | hk-vps 改名或复制私有目录                 |
| offsite     | 真实独立挂载、authority、完整副本和从副本 drill              | 同盘目录、bind mount、本地 shadow restore |
| alerting    | 外部 receiver receipt 与 clear                               | unit、journal、发送端 2xx                 |
| capacity    | 预冻结画像的两倍负载、增长与维护峰值                         | 空闲时资源截图                            |
| recovery    | 离机 joint recovery、RPO/RTO、失败重入                       | 只跑 `pg_restore` 或只看 manifest         |
| release     | exact green SHA、guarded deploy/rollback、API/UI             | `/health=200` 或维护树安装                |

## 6. 不在 5.1 范围

- 真实顾客 PII 导入、单门店正式营业、V1 正式迁移和业务 SLA；
- 短信、微信、AI、支付或配送 provider 的真实调用；
- 多地域 active-active、高可用数据库或自动故障转移；
- macOS/Windows 正式签名发行、XP-58 与其他实体硬件；
- 新产品命令、查询、业务功能或用容量测试改写产品语义。

## 7. 紧接的下一动作

1. manpengan 审阅并签署/修订 ADR-65；
2. 提供或选择 production-candidate、离机介质、告警接收端和容量画像责任人；
3. 在只读差距盘点后，把 5.1-B 拆成首个可合入 PR；
4. 在任何外部主机变更前再次列出精确对象并取得对应授权。
