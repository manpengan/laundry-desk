# 通用 V2 阶段 5 生产化交付计划

> 日期：2026-08-17
> 状态：**5.0 路线重置与发布解阻进行中**
> 当前裁决：[ADR-64](../../adr/2026-08-17-adr-64-stage5-productionization-and-release-retention.md)
> 已完成基线：[Cloud Web-first 1–4 交付计划](2026-08-10-post-adr36-delivery-plan.md)
> 当前 live 证据：[2026-08-15 归档工具修复发布结果](../../operations/2026-08-15-artifact-archive-release-result.md)

## 1. 目标与推进规则

阶段 1–4.5 已完成。本计划把活动路线从“补齐 Cloud Web 功能”切换为“建立可持续发布和生产
基线”，仍以 GitHub `main`、required checks、精确 SHA 部署和新鲜远端证据作为关闭真源。

推进规则：

1. 每一切片先冻结边界、实现并通过本地门禁，再经 PR 合入 `main`；服务器不产生私有补丁。
2. 涉及远端 rename、归档、部署、真实数据或 provider 的动作必须有精确对象与单独授权。
3. 任何远端动作都使用既有固定 SSH authority、同一 release lock 和 root-only 工具；门禁缺失时
   失败关闭，不绕过固定指纹、专用密钥或身份检查。
4. 5.0 不新增命令、查询或迁移；后续若扩大对外能力，继续遵守 ADR-16 的同 PR ADR/CHANGELOG/
   验收记录门禁。
5. 在 5.1 关闭前只使用合成数据，不把 hk-vps 称为生产 SaaS。

## 2. 固定交付顺序

| 阶段 | 状态       | 范围                                               | 关闭证据                         |
| ---: | ---------- | -------------------------------------------------- | -------------------------------- |
|  5.0 | **进行中** | 路线重置、四类发布留存受控归档、恢复发布 preflight | ADR-64 §5                        |
|  5.1 | 未开始     | 生产环境隔离、离机备份、告警、容量与联合恢复       | 独立 ADR 与真实介质/演练证据     |
|  5.2 | 未开始     | 单门店受控试点、真实数据授权、SLO、必要的 V1 迁移  | 独立 ADR 与试点运行证据          |
|  5.3 | 未开始     | 短信/微信、AI 及其他获授权 provider                | 真实 sandbox/回执/失败与撤销证据 |
|  5.4 | 未开始     | macOS、Windows、XP-58 与桌面对齐                   | 各平台和硬件独立实证             |

## 3. 阶段 5.0 工作分解

### 5.0-A 路线治理

- 新增 ADR-64 和本计划；
- 更新 ADR 索引、AGENTS、README、CHANGELOG 与旧 1–4 计划的后继关系；
- 明确 69 commands / 48 queries、迁移头 0069 均不变化。

### 5.0-B `/opt` 单树归档

- 保留 rolled-back 与 orphan 两条既有路径；
- 增加 superseded committed rollback 路径；
- 当前 live、无 committed live history、多条 committed 或冲突绑定、marker 相同、跨设备、目标碰撞全部拒绝；
- 补齐候选列表、同 inode rename 和反向恢复所需证据。

### 5.0-C release-set 归档

- 用无秘密的 `candidate SHA + release-token digest` 精确选择记录；
- 把 history、controller、可选 backup 对和可选 finalize evidence 作为一个 manifest-bound set；
- 工具支持只读列表、显式 archive、显式 restore 和中断后幂等重入；
- active `/opt` 引用、live 记录、活动 transition、非同设备、owner/mode/digest/binding 漂移均拒绝。
- 留存已满而 live 缺少工具时，只从 clean、required-check 绿灯的 exact `main` 安装 root-private
  维护树；不形成 server-only patch，安装与后续精确归档分开授权。

### 5.0-D 本地与主干门禁

- 定向 Node tests；
- `pnpm cloud:adr36:acceptance:test`；
- `pnpm workspace:check`；
- PR 合入后核对精确 merge SHA 的 required checks。

### 5.0-E 远端解阻与发布

1. `status` 和只读盘点核对无活动 transition、live marker、四类计数与精确候选；
2. PR 合入且 exact `main` required checks 绿灯后，安装其 root-private 维护树；
3. 用维护树只读 list；对另行授权的精确对象先执行 `/opt` 退役，再执行完整 release-set 归档；
4. 复核 inode、manifest、剩余 active 一一绑定、磁盘、systemd、loopback 与公网健康；
5. 运行 release preflight，确认 retention limit 全部解除；
6. 把同一精确 `main` 正式发布到 hk-vps，再用 live runner 重复只读 `inventory`、列表与
   `preflight`；本步骤不执行远端 restore，任何真实 release-set restore 仍须为精确对象另行授权；
7. 回写一份不含 token、秘密或真实 PII 的阶段 5.0 发布结果。

当前执行环境已生成专用 `~/.ssh/hk_vps_ed25519`、写入精确 `Host hk-vps` 配置并核对服务器
Ed25519 fingerprint 与仓库固定值一致。截至 2026-08-20，严格 key-only 路径已经通过远端
`status` 复核；后续 5.0-E 继续使用同一固定 authority，不启用密码，也不降低主机密钥或身份校验。

## 4. 5.0 关闭检查表

- [ ] 治理文档一致；
- [ ] `/opt` superseded 路径与负向测试通过；
- [ ] release-set archive/restore/重入测试通过；
- [ ] 全量本地门禁通过；
- [ ] PR 合入与精确主干 required checks 通过；
- [ ] hk-vps 精确候选归档完成且四类 active 集合仍一致；
- [ ] retention preflight 通过；
- [ ] 新工具随精确 `main` 上线并完成远端只读复核；
- [ ] 阶段 5.0 结果回写。

## 5. 不在 5.0 范围

- 真实顾客数据、V1 正式迁移；
- 生产域名、SLA 或多节点高可用；
- 真实短信/微信/AI/provider 调用；
- macOS 签名公证、Windows、XP-58；
- 新产品功能、命令、查询或数据库迁移。
