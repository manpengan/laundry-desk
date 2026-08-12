# 阶段 4.1 Cloud 数据保护验收记录

> 日期：2026-08-12
> 状态：**本地 software-only 实现、真实 PostgreSQL、workspace 与独立安全终审已通过；真实离机存储、告警接收端与 hk-vps 演练未授权/未执行**
> 决策：[ADR-43](../../adr/2026-08-12-adr-43-cloud-data-protection-and-joint-recovery.md)
> 基线：未提交 Stage 3.2–3.4 工作树；`main=origin/main=1c25dfd4423bb9033673e47bc058158086929407`

## 1. 范围

本记录只覆盖 root-only Cloud PostgreSQL + 私有照片一致恢复集、离机网络文件系统副本、影子
恢复演练、数据保护健康状态和代码/迁移/数据库/照片联合恢复。它不增加业务命令/查询或 Web
入口，也不包含通知、店厂交接、取送、营销、自助、AI/BYOK 和 Stage 5 硬件/桌面门禁。

## 2. 证据矩阵

| 层级                | 目标                                                            | 当前状态                     |
| ------------------- | --------------------------------------------------------------- | ---------------------------- |
| ADR/Threat boundary | root-only、同一锁、固定路径、恢复集与失败关闭语义               | 已冻结                       |
| Backup              | 停服 + NOLOGIN 下绑定 DB dump、catalog、ledger 与逐文件照片摘要 | 本地实现与回归已通过         |
| Drill               | 新影子库恢复、catalog/ledger/photo inventory 精确一致并清理     | 本地实现与回归已通过         |
| Offsite             | 严格网络挂载、独立设备、原子复制、目标端重验、上限保护          | 软件失败关闭；真实目标待授权 |
| Monitor             | 26h/26h/8d 阈值、严格状态/metrics、timer 与失败退出             | 软件已通过；真实告警待授权   |
| Joint recovery      | pre-recovery 安全点、精确代码 SHA、DB/照片恢复和失败停服        | 本地实现与真 PG 已通过       |
| PostgreSQL          | 全新 PG16 + 合成照片 backup/mutate/drill/recover 与故障注入     | 已通过                       |
| Workspace/Security  | format/lint/test、独立数据库/安全/静默失败复核                  | 已通过，P0/P1/P2 均为 0      |
| GitHub/hk-vps       | PR/CI、systemd、真实 offsite、受控恢复和实际告警                | 未授权/未执行                |

## 3. 本地软件证据

- 定向 runner/状态/文件/锁/offsite/systemd/CLI 与 foundation 回归：102 项中 101 通过、0 失败、
  1 项仅因 macOS 跳过；同一 Linux-only 锁继承集成回归已在只读 Linux 容器 1/1 通过。ESLint、
  Prettier、文件规模和 `git diff --check` 全绿。
- 全新隔离 PostgreSQL project `laundry-commission-pg-f9cb0591` 应用/重放 51 个正式迁移，完成
  commissioning、Stage 3 真实数据回归、catalog write gate，以及 DB + 合成私有照片的
  backup → mutation → shadow drill → joint recovery；恢复集为
  `manual-20260812T005348Z-3be3235e01d8db1f`。
- 验收输出 `CLOUD_DATA_PG_ACCEPTANCE_OK` 与 `LOCAL_FRESH_COMMISSIONING_ACCEPTANCE_OK modes=pg`；
  结束后精确 container、volume、network、临时 PG config root、5173/8543/8787 监听及
  Playwright/Chromium/commissioning 进程均为 0。
- 最终 `pnpm workspace:check` exit 0：dependency audit high/critical 为 0，format、lint 9/9、
  typecheck 12/12、Foundation 278/278、Cloud 269 通过/0 失败/1 个 Linux-only macOS skip、
  build 9/9；Stage 4.1 定向回归也在 workspace test 中重复通过。最终清理状态覆盖备份、离机、
  影子库与恢复准备的双失败，保留可定位 operation 并持久化最终失败码。
- 独立只读安全终审复核生产 dump FD、flock 证明、离机路径/故障域、恢复锁序、失败状态和
  systemd 沙箱，最终结论 P0=0、P1=0、P2=0。
- 本地没有真实 offsite authority，按设计只能形成 `software_only` / `blocked_external_offsite`
  证据；没有将 fake mount、unit 静态测试或 journal 冒充外部闭环。

## 4. 不可替代的关闭条件

- release-time database-only dump 不能替代数据库 + 照片恢复集。
- 同机 shadow database 不能替代离机副本；fake mount 只能标记 `software_only`。
- 文件存在不能替代逐文件摘要、数据库引用清单和恢复后 catalog/ledger 对比。
- health 200 不能替代写门闩、操作状态、精确 marker/migration 或恢复失败保持停服。
- systemd timer 已安装不能替代实际执行历史和告警接收证据。
- 本地真实 PostgreSQL 验收不能替代 hk-vps 的权限、网络挂载、容量和受控恢复演练。

## 5. 当前外部边界

- 本轮只有实现与本地测试授权，没有 commit、push、PR、merge、hk-vps 变更或恢复演练授权。
- 没有经验证的 offsite 网络挂载、远端加密/不可变留存证据或告警接收端。
- 因此软件门禁完成后最多标记 `software_only`；Stage 4.2 可按既定顺序继续，但生产性声明保持
  `blocked_external_offsite` / `blocked_external_alerting`。
