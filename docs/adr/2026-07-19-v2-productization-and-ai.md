# RFC: v2 产品化架构 + AI 能力层（总纲）

- 日期：2026-07-19（同日历经 draft2 → draft3 → draft3.1 → **draft3.1a** 四轮修订）
- 状态：**Proposed**（终审裁决：**ADR-05/06 已单独转 Accepted**；RFC 与 ADR-01/02/03/04/07/08 待 draft3.1a 补丁经 Codex diff 复核后签署，无需再做完整终审轮）
- 决策人：manpengan；起草：Claude（设计与门禁）；修订依据：Codex 2026-07-19 三轮评审

## 背景

顺科复核与国内外竞调确认 laundry-desk 从宏发单店工具升级为行业产品，并以 AI-first 方式内建大模型 agent 能力（BYOK 多厂商）。设计真源：

- `docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`（v2.0-**draft3.1a**）
- `docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md`（v2.0-**draft3.1a**）

## 本 RFC 的角色

原单一 ADR 捆绑了过多独立决策（Codex 二审意见），现拆分。本文件保留为总纲与索引；各子 ADR 独立评审、独立转状态：

| 子 ADR | 主题 | 状态（终审后） |
|---|---|---|
| [ADR-01](2026-07-19-adr-01-web-first-edge-agent.md) | Web-first + Local Edge Agent | Proposed——待 draft3.1a 补丁 diff 复核 |
| [ADR-02](2026-07-19-adr-02-postgres-multitenancy-rls.md) | PostgreSQL 多租户与 RLS（M1 强制） | Proposed——**内容已过终审**（补 WITH CHECK 模板），按批量门禁随补丁一并签署 |
| [ADR-03](2026-07-19-adr-03-garment-order-accounting-model.md) | 件级衣物 / 订单行 / 账务状态模型 | Proposed——**内容已过终审**，按批量门禁随补丁一并签署 |
| [ADR-04](2026-07-19-adr-04-offline-consistency.md) | 离线一致性 | Proposed——draft3.1a 已补可信时间契约，待 diff 复核 |
| [ADR-05](2026-07-19-adr-05-ai-command-policy-approval.md) | AI 命令总线 / 风险策略 / 确认与审批 | **Accepted（2026-07-19 终审裁决）** |
| [ADR-06](2026-07-19-adr-06-byok-provider-network-key-mgmt.md) | BYOK / Provider 网络 / 密钥管理 | **Accepted（2026-07-19 终审裁决）** |
| [ADR-07](2026-07-19-adr-07-v1-migration-and-milestones.md) | v1→v2 迁移与里程碑（方案 B） | Proposed——待 diff 复核 |
| [ADR-08](2026-07-19-adr-08-release-desktop-upgrade-lts-support.md) | 发布、桌面升级、LTS 与技术支持（三审新拆） | Proposed——draft3.1a 已修回滚冲突，待 diff 复核 |

## 二审处置记录（2026-07-19）

Codex 二审六项 P0 全部采纳并已落入 draft2：AI 基座前移 M1（统一命令总线 + Tool Registry）；RLS 提前 M1（FORCE + 非 owner 角色 + 负向测试）；删除"AI 写操作免确认"→ 有边界自动化策略 + WYSIWYS 确认卡；硬件桥升级 Local Edge Agent（签名模板本地渲染，解决离线打印矛盾）；BYOK 出口 SSRF 硬化；`order_lines`/`garments` 拆分并补 `delivered` 转移。里程碑采纳方案 B（AI-first 垂直切片，M0–M6.4）。

裁决的两处评审内部张力：批量通知采用**数量阈值风险升级**（小批量 R3 单次确认 / 大批量 R4 审批），兼容"M3 上线草稿+确认发送"与"批量通知列 R4"；BYOK 安全属性（加密/verifyKey/官方白名单）M2 一步到位，厂商广度与计费面板 M5 补全。

## 第二轮处置记录（2026-07-19，同日）

第二轮二审确认一轮六项方向全部通过，另提六项**契约级 P0**，已全部以补丁形式落入 draft3（未全文重写）：

1. 租户数据模型可执行化：业务表持 `org_id/store_id`、子表组合唯一/外键、策略模板仅本行字段比较、五类旁路负向测试、租户上下文禁自报（架构 §4/§7，ADR-02/03）。
2. Edge 签名方向修正（服务端能力票据 / 设备执行回执 / offline grant 含权限版本）、SQLCipher **随机 DEK + OS 凭据区 KEK**（废弃"从设备签名私钥派生"的错误设计）、解绑清单、**Primary Edge 防双花裁决**、M0 增补 Windows WSS/LNA 实测（架构 §10/§11，ADR-01/04）。
3. BYOK 密钥契约固化：独立 DEK、96-bit nonce、AAD 绑定、KEK 包装、key_version 轮换、自托管 OS Secret Store（架构 §9.7，ADR-06）。
4. 审计同事务 + audit_log 仅 INSERT + canonical args 服务端冻结 + AI 数据表 RLS/保留期/删除联动（架构 §6.5/§8/§9.5/§9.8，ADR-05）。
5. 票号不变量改为"门店内唯一、单调、永不复用，空洞可审计"，配套时区/营业日/号段回收与作废规则（架构 §6.1/§7，ADR-03）。
6. R4 拆两级：M1 同步 step-up 复核（原子单次消费，操作者不可自核），M5 异步审批中心——消除 M2 的 R4 命令与 M5 审批中心的里程碑冲突（架构 §6.5/§9.4/§14，ADR-05/07）。

P1 四项同步落地：Web 会话/CSRF 契约（§3）、命令元数据四字段（§6.5）、支付流水只追加+红冲（§6.1/§7）、UI 件级抽屉删除"数量"（UI §4.2）。另按用户要求新增：**§13 发布/升级/技术支持规划 + 桌面端同步开发承诺**（ADR-01/07 同步）。

状态：ADR-03 已补租户组合键，具备转 Accepted 条件（待 manpengan 确认）；总 RFC 与其余 ADR 保持 Proposed 待三审。
【更正：上句对 ADR-03 的判断被三审推翻——二元组合键不防跨门店，且票号"单调"承诺不成立；两项已在 draft3.1 修正，ADR-03 回到待终审状态。】

## 第三轮处置记录（2026-07-19，同日）

三审确认二轮七项闭环（BYOK 密钥信封、审计同事务、canonical args、R4 step-up、命令元数据、支付红冲、UI 数量），另提四项 P0，已全部落入 **draft3.1**（小补丁）：

1. **组合外键三元化**：店级父表 `UNIQUE(org_id, store_id, id)`，子表三元组合外键；`garments → order_lines` 含 `order_id` 防同店跨订单挂行；六张子表同构（架构 §4/§7，ADR-02/03）。
2. **Primary lease**：与普通 offline grant 分离，绑定 `primary_epoch/not_before/not_after`，同店至多一个有效，新 lease 待旧设备在线释放或旧 lease 到期后生效（等待期新设备在线-only）；**离线退款一律禁用**（R4 须在线 step-up）；"解绑即擦除"修正为**服务端吊销原子、本地擦除 best-effort**（架构 §10/§11，ADR-01/04）。
3. **桌面断网冷启动**：安装包内置签名 last-known-good SPA + `app://` 协议加载本地 UI；Electron 安全基线（contextIsolation/sandbox/webSecurity/最小 preload/导航限制）（架构 §13.3，ADR-01）。
4. **Edge 升级状态机**：A/B 双槽 + 健康检查 + 升级前加密快照 + 本地库三段式 + 队列信封独立版本化 + 旧队列回放接口长保留 + 回滚判定（旧版可读当前 schema 否则恢复模式/前滚）+ 签名与最低安全版本 + 更新期禁发 lease（架构 §13.5，新 ADR-08）。

P1 同步落地：票号去"单调"（时间排序用 ULID）；N-1 明确为 **contracts 协议 major**；新增 LTS 渠道与五维支持矩阵；LTS 持续跟进 Electron/Chromium 安全版本；远程协助收紧（重新认证/实时撤销/MFA/出站连接/命令级只读白名单）；总 RFC 头部与 ADR-03 误判已更正；§13 拆出 ADR-08。

**用户裁定并已落档**：后续**桌面端为主、Web 次之**；前期开发起**本地 web 服务（单机模式）**做测试适配（架构 §2/§13.3，ADR-07/08）。

四项 P0 均已写成不变量并进入 M0/M1 验证矩阵（架构 §14）：Primary lease 时序演练、冷启动演练、A/B 升级回滚演练、三元组合键随 contracts 冻结。

## 终审处置记录（2026-07-19，同日第四轮）

终审确认三审四项 P0 主体方案全部正确落档，整体架构进入收口阶段；另提 1 项实质 P0 + 1 项文档冲突 P0 + 六处 P1，已全部落入 **draft3.1a** 小补丁：

1. **P0-1 Primary lease 可信时间契约**：lease 升级为签名对象 `{lease_id, issued_at, ttl_ms, max_clock_skew_ms, …}`；Edge 禁用墙钟判到期（签发时间锚点 + 单调时钟）；进程/OS 重启、休眠恢复、时钟跳变无法证明时间连续性 → **lease 立即失效 fail-closed**，取衣/收款降级 online-only；离线高危命令绑定 `lease_id + primary_epoch + per_lease_seq`（回放按 epoch/seq 拒收过期命令）；无签名 release ACK 时新 lease 须等旧 lease 到期**并越过容差**；M0 增加六类时钟演练（回拨/前跳/进程重启/OS 重启/休眠跨期/旧主失联）。落点：架构 §7（primary_leases 表）/§10/§11/§14，ADR-04。
2. **P0-2 回滚表述冲突**：§13.3 "失败自动回滚上一版本" 改为 "按 §13.5 与五维支持矩阵判定：兼容才回原槽，不兼容进恢复模式并前滚修复"。
3. **P1 六项**：Edge 兼容窗口改"当前及上一 contracts major"；§16 晋升表述改"旧主在线释放或等待可信 lease 到期"；ADR-04 后果"解绑即擦除"改为吊销原子/擦除 best-effort；架构头部 ADR 引用改 01…08；本 RFC 设计真源版本号更新；UI 取衣页高危按钮改纯文字标记。另按终审补充：RLS 策略模板明确含 **WITH CHECK** 写入约束（§4，ADR-02）；研究报告中仓库外绝对路径插图引用已移除。
4. **签署**：ADR-05、ADR-06 依终审裁决转 **Accepted**；ADR-02/03 内容已过终审，按批量门禁随补丁一并签署。
5. **素材裁决（shunke/ 不入公开 Git）**：93 张原图约 610 MB 且全部含 GPS/设备 EXIF，仓库为 PUBLIC 且无 LFS——原图放私有存储；代表性图片经**去 EXIF、压缩、顾客信息遮盖**后收入 `docs/assets/shunke/`；基线 commit 为 docs-only 并排除 `shunke/`。

## diff 复核处置记录（2026-07-19，同日第五轮）

快速 diff 复核确认回滚冲突、contracts major、WITH CHECK、UI/路径 P1 全部通过，余一簇 lease 精确化 + `.gitignore` 锚定，已落档：①**签发串行化**——新增 `primary_lease_heads(org_id, store_id)`（PK 二元）+ `primary_leases UNIQUE(org_id, store_id, primary_epoch)`，签发/release ACK/晋升同一事务内对 head 行 `SELECT ... FOR UPDATE` 后 epoch++，提交后才返回签名 lease；②**截止公式固定**——`server_not_after = issued_at + ttl_ms`（入签名），`local_deadline = request_start_mono + ttl_ms − safety_margin_ms`（锚点取发起请求前），Edge 授权恒 ≤ `not_after`，RTT ≥ TTL fail-closed；③**epoch/seq 职责边界修正**——只管幂等/防重放/顺序/审计归属，旧 epoch 回执写不可变审计、不自动应用、转仲裁，防物理双交付依赖串行化+不重叠 lease+可信截止；④M0 增加并发签发与长 RTT 演练；⑤`.gitignore` 改根锚定 `/shunke/`（不再误伤 `docs/assets/shunke/`）。落点：架构 §7/§10/§14，ADR-04。

## 转 Accepted 的条件

1. ~~ADR-05/06~~ **已于 2026-07-19 转 Accepted**（终审裁决）。
2. 其余（RFC、ADR-01/02/03/04/07/08）：Codex 对 **draft3.1a 补丁 diff 复核通过**（终审明示无需再做完整审核轮）+ manpengan 签署（重点确认：lease 可信时间 fail-closed 的可用性代价、离线退款禁用、桌面为主交付顺序、LTS 承诺）。

## 全局影响

- v1 spec（2026-04-23）继续约束宏发 M1–M4 收口，不作废。
- README 路线表与 CLAUDE.md 在 v2 开工时同步更新。
