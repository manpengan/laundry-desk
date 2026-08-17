# ADR-64：阶段 5 生产化接续与发布留存归档

- 日期：2026-08-17
- 状态：**Accepted**
- 决策者：manpengan（会话裁决：“先从 5.0 开始”）
- 前序：[ADR-37：Cloud Web-first 主交付线](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 执行计划：[阶段 5 生产化交付计划](../superpowers/plans/2026-08-17-stage5-productionization-plan.md)
- 影响：活动路线、发布留存、Cloud 生产化顺序、桌面与外部提供商优先级

## 背景

ADR-37 的阶段 1–4.5 已全部完成并发布到 hk-vps。通用 V2 Cloud Web 的既定软件面已经闭环，
但 hk-vps 仍是只允许合成数据、可丢弃的开发测试环境；真实 provider、离机备份、生产容量、
正式桌面发行和实体硬件证据均未取得。

原 1–4 计划已经没有未关闭的产品切片，却仍被 README、AGENTS 和计划文件称为“当前路线”。
与此同时，最近一次发布后 history、root 私有 controller、恢复点 backup set 均达到 8 组，
`/opt` 常驻发布树达到 6 棵。下一次 `prepare` 会在进入停写窗口前失败关闭。现有仓库工具只
覆盖部分 `/opt` 退役产物；history/controller/backup 仍需人工成组搬迁，成功发布产生的
committed rollback tree 也没有受控退出路径。

因此，下一步不是继续扩大产品契约，而是先恢复可持续发布能力，再把 Cloud Web 从开发测试形态
推进到可承载受控试点的生产基线。

## 决策

### 1. 阶段 5 成为新的活动交付线

阶段 5 按以下顺序推进：

1. **5.0 路线重置与发布解阻**；
2. **5.1 Cloud 生产基线**：环境隔离、离机备份、恢复介质、监控告警、容量与事故回滚；
3. **5.2 受控试点**：单门店投产、真实数据授权、SLO、运行手册与必要的 V1 迁移；
4. **5.3 外部提供商**：短信/微信、AI，以及后续获授权的支付或配送 provider 独立验收；
5. **5.4 桌面与硬件独立线**：macOS 正式发行、Windows 安装链、XP-58 和逐功能桌面对齐。

5.0 未关闭前不开始 5.1；5.1 未形成真实数据保护和事故恢复证据前，不允许 hk-vps 或其后继环境
承载真实顾客 PII，也不宣称生产 SaaS。外部账号准备可以并行，但不得提前形成 provider 完成声明。

### 2. 5.0 不扩大产品契约

5.0 只改变治理文档和 root-only 发布运维工具，不新增或修改 HTTP/IPC、Command/Query Bus、
数据库迁移、`m2-freeze.test.ts` 清单或业务权限面。若实现过程中发现必须扩大其中任一边界，
应停止本切片并另立精确 ADR。

### 3. `/opt` 退役树使用三条互斥授权路径

现有同文件系统、可逆 rename 继续作为唯一移动原语，不删除发布树：

- `rolled_back` 且非权威的 history-bound failed/rollback tree 使用既有受控路径；
- transition 账本从未认领的 pre-ledger tree 使用独立 orphan 路径，并要求树内 marker 与 live 不同；
- 已被后续成功发布取代的 committed rollback tree 使用新的 superseded 路径。

superseded 路径只接受 rollback tree，并必须同时证明：恰好一条 committed、权威 history 经
`rollback_path` 绑定；该记录不是当前 live；当前 live 自身存在 committed history；目标树 marker
精确等于该记录的 `expected_sha` 且与 live 不同。同候选、同旧版本的早期 `rolled_back` 非权威重试记录可以并存，但第二条
committed 或任何候选/旧版本冲突都必须失败关闭。当前 live 的即时回滚树永远不具备资格。

### 4. 发布证据必须按完整 release set 归档

history 不是可单独搬走的计数文件。一个 release set 至少包含该 history 绑定的：

- root 私有 controller；
- 可选 backup dump 与 verified manifest；
- 可选 finalize verification evidence；
- history 本身。

release-set 工具必须满足：

1. 只在同一 release lock 下、无活动 transition 时运行；
2. 首次动作前验证 active history/controller/backup/evidence 的严格一一绑定、摘要、owner 和 mode；
3. 拒绝 live 记录；rolled-back 记录必须非权威，committed 记录必须已被 live 取代；
4. record 仍引用的 `/opt` 树必须先通过本 ADR §3 的独立路径退役，不能把活动树变成 orphan；
5. 先持久化精确 manifest，再逐项原子 rename；中断后可按 manifest 幂等继续或反向恢复；
6. 归档和恢复后重新验证 active 集合及 archive set，任何缺失、复用、碰撞、跨设备、符号链接、
   摘要或身份漂移都失败关闭；
7. 不自动选择“最老”记录，不自动清理，不使用 glob，不删除任何发布证据。

若 live 尚不含 5.0 工具、而留存上限又阻止其正常发布，只允许通过固定 SSH authority 安装一个
**精确绿灯 main** 的 root-private 维护树：本地必须 clean `main == origin/main` 且 required checks
通过，远端必须在无 transition、同一 release lock 下验证 Git archive 摘要并原子发布到
`/var/lib/laundry-desk-release-maintenance/trees/<sha>`，原 archive 作为来源证据保留。维护树安装与
精确对象归档是两次独立授权；它不得修改 live、数据库或服务，也不构成部署完成声明。

归档根继续是 root-only `/var/lib/laundry-desk-release-archive`。归档只是从发布前置计数中退出，
不改变原 history 的 outcome、权威性或证据内容。

### 5. 5.0 的关闭条件

5.0 只有同时满足以下条件才可关闭：

- ADR、AGENTS、README、CHANGELOG、当前计划和运维手册一致指向阶段 5；
- `/opt` 与 release-set 归档工具通过失败路径、恢复路径、中断重入和文件身份测试；
- 精确 `main` required checks 绿灯，且工具本身已进入 hk-vps live 部署树；
- 在同一 release lock 下完成新鲜只读候选盘点，并经单独授权归档精确对象；
- 远端无活动 transition、服务与共享站点健康，active history/controller/backup/evidence 仍严格
  一一绑定；history/controller/backup 均至少留出一格，`/opt` 常驻计数不高于 5；
- 再次执行 release preflight 不再返回任何 retention limit 错误。

本 ADR 不把“仓库工具已实现”冒充“远端槽位已腾出”，也不把“发布可继续”冒充生产就绪。

## 理由

- 当前最大风险已经从业务功能缺失转为发布链不可继续和生产证据不足。
- history、controller、backup、evidence 是一个恢复与审计对象，拆开人工搬迁容易制造 orphan。
- 同文件系统 rename 保留 inode、避免复制中断，并可反向恢复；显式 manifest 使多对象移动可重入。
- 保留当前 live 的即时回滚树，同时退出已被取代的旧树，兼顾发布连续性与故障恢复。
- 先完成生产基线再接真实数据和 provider，避免用功能绿灯掩盖数据保护与外部依赖缺口。

## 否决的备选

- **提高留存上限**：只推迟磁盘与计数问题，不建立退役语义，否决。
- **按时间自动删除最旧对象**：时间不能证明对象已被取代，也不能证明四类绑定完整，否决。
- **只移动 history 让其他对象变成 orphan**：下一次 preflight 会失败，且恢复证据分叉，否决。
- **归档当前 live 的 rollback tree**：会移除最新即时恢复路径，否决。
- **直接把 hk-vps 改称生产环境**：离机备份、告警、容量和真实数据治理证据仍缺失，否决。
- **同时启动 5.1–5.4**：会重新把外部凭据、桌面和硬件混入 Cloud 生产化关键路径，否决。

## 后果

- ADR-37 的 Cloud Web 主形态和安全边界继续有效，但其 1–4 顺序从活动计划变为已完成基线。
- 阶段 5 计划成为当前执行入口；桌面/硬件仍后置，直到 5.4 被明确启动。
- 5.0 会增加 root-only 运维代码与证据，但不会改变产品命令、查询或迁移头。
- 真实 provider 与离机介质继续分别保持 `blocked_external_provider`、
  `blocked_external_offsite`，直至对应阶段取得真实证据。
