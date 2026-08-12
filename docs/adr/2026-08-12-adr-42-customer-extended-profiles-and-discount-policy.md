# ADR-42：顾客扩展档案、运营豁免与折扣政策

- 日期：2026-08-12
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-14：通用 V2 本地优先架构](2026-07-25-adr-14-generic-local-first-v2-delivery.md)、
  [ADR-19：普通 offline grant 权威重放](2026-08-01-adr-19-ordinary-offline-grant-replay.md)、
  [ADR-20：权威打印与顾客隐私快照](2026-08-01-adr-20-authoritative-edge-print-dispatch.md)、
  [ADR-38：柜台可信计价](2026-08-11-adr-38-cloud-counter-trust-closure.md)、
  [ADR-41：会员权益与有效期](2026-08-11-adr-41-member-benefits-and-expiry.md)
- 影响：顾客契约、组织级 PII、隐私生命周期、离线重放、订单计价与快照、会员等级、打印/上挂、
  Web 与 Cloud 验收

## 背景

现有 `customers` 只保存手机号、姓名和备注；已有组织级搜索、合并、隐私导出与匿名化，但不能
保存多地址、车牌/标签或顾客级服务偏好。柜台折扣只有管理员手工固定整数分，ADR-41 的会员
等级也明确尚不影响订单价格。

活动架构与竞品证据中的“免责声明”实际是顾客级运营豁免：不打取衣单、不打水洗唛、不分配
挂点。它不是法律电子签署或免责合同。把一个店员勾选框包装成顾客签名会制造不可证明的法律
证据，本阶段明确不这样做。

实现前复核还确认三项既有隐私缺口：merge 可形成多跳且只重连发起门店订单；通用审计、幂等、
确认卡和 Edge replay 会保存顾客 PII 副本；匿名化后，断网旧队列可以用原手机号重新建档。0051
必须先关闭这些基础缺口，不能只新增 profile 表后继续宣称“不可逆匿名化”。

## 决策

### 1. 扩展档案继续属于组织级顾客

新增组织级 `customer_profiles`、`customer_addresses` 和 `customer_identifiers`。它们只通过服务端
会话注入 `org_id`，全部启用并强制 RLS；客户端不能提交租户、操作者或可信时间。

`customer.profile.get`（R2、`customer_read`）返回一个活动顾客的有界扩展档案；不存在 profile
行时返回 `version=0` 的空档案，不因读取而写库。`customer.profile.set`（R3、
`customer_write`）以 `customer_id + expected_version` 做 CAS，一次替换：

- gender：`unspecified | female | male | other`；
- 最多 10 个地址，每个含标签、可选收件人/联系电话、地址正文和至多一个默认项；
- 最多 20 个标识，类型为 `vehicle_plate | tag | external_ref`，同组织同类型活动规范化值唯一；
- 首选联系渠道 `none | phone | sms | wechat` 与最多 256 字服务备注；
- 三个运营豁免：`skip_ticket_print`、`skip_label_print`、`skip_rack_assignment`。

地址和标识更新不物理删除结构历史；旧活动行在写入 `retired_at` 的同一语句中清空 raw/normalized
标识、自由文本地址标签、地址正文、收件人和联系电话，只保留行 id、所属 profile version 与退役
时间证据，
随后插入新版本。活动标识使用 partial unique
`(org_id, kind, normalized_value) WHERE retired_at IS NULL AND normalized_value IS NOT NULL`，退役或
匿名化后不继续占用规范化值。普通审计只记录版本、数量、gender、联系渠道和豁免布尔值，不
记录地址、车牌、外部标识或服务备注正文；写命令结果只返回 customer id、新版本和数量。

手机号列表继续脱敏。`customer.search` 只允许规范化标识的精确匹配，且不返回标识值；详情只在
已认证 `customer_read` 顾客页返回完整 PII。既有顾客查询补显式 RBAC，不再依赖当前角色权限
集合恰好重叠；privacy event 原因只对 privacy-admin 返回。

### 2. 所有顾客能力共享递归 canonical group

既有模型允许 A→B 后再把 B→C，且旧 merge 只重连发起门店的订单。扩展档案读取、手机号解析、
搜索、订单归属、隐私状态、导出和匿名化都必须从活动目标递归追溯全部 merge source，组成同一
canonical customer group，不能只看目标或直接来源。

递归 helper 必须携带访问路径、拒绝环并限制深度和总行数；发现损坏链时失败关闭。历史数据继续
递归兼容；新 merge 在锁定整个入边集合后把来源组扁平化到最终活动 root，并重连组织内全部门店
订单，避免继续制造新多跳和跨门店孤儿。合并必须在任何会员、订单或顾客写入前，对来源组与
目标组去重后的总成员数执行 `<=1000` 门禁；超限整笔拒绝，不能先修改会员归属再失败，也不能
制造后续隐私导出/匿名化都无法处理的 poisoned group。内存与 PostgreSQL 实现遵守同一边界。

新 profile 写入会退休 canonical group 的旧活动地址/标识并把新版本写到活动目标。目标已有
profile 时其标量设置优先；目标尚无 profile 时读取最近更新的来源 profile，直到下一次显式保存。
不能自动拼接服务备注或暗中选择折扣来猜测冲突结果。

### 3. 隐私导出和匿名化覆盖所有持久副本

`customer.privacy.export` 升级为 `format_version=2` 的有界 JSON：保留单值 `profile` 作为活动 root
优先的兼容视图，同时用 `profiles` 返回 canonical group 中每一条仍含 PII 的 profile，并返回
canonical group、活动地址/标识和各自 `count/truncated`。旧客户端必须对未知版本失败关闭，不能
静默丢弃新增字段。因为退役行已即时清掉直接 PII，导出只需返回其非 PII 结构计数，不会隐藏仍
保存的历史正文。导出还以总量 1000 为界返回 `related_narratives`：支付、衣物明细、衣物、履约、
会员资金/等级/积分/次卡/优惠券及主体关联 audit 的原始备注/原因，并返回
`related_narrative_count/truncated`；执行时按 customer→account→print→order→garment 锁序冻结
主体锚点，避免并发写入形成半截快照。redaction 清单同步覆盖地址电话/正文、标识值、全部 profile
服务备注和整组关联叙述。

完整导出不得写入通用 `command_idempotency`。它仍是 `idempotent=false` 的 R4 同步操作；响应
丢失后只能重新授权导出并产生新 privacy event。若未来需要续取，必须使用短 TTL、加密、仅
privacy-admin 可读的专用 artifact，不能把完整 PII 永久塞进通用重放表。

privacy event 的 `reason` 只能取 `customer_request | legal_request | data_correction |
retention_expiry` 受控代码，不能保存姓名、手机号或自由文本；0051 把既有自由文本统一归一为
`legacy_request`。事件保持 append-only，按完整 recursive canonical group 查询，因此 A→B→C 后
从任一历史 id 仍能看到 A/B/C 的既有事件，而不只看到最终 root 上新写的事件。

0051 为 `ai_pending_actions`、`command_idempotency` 和 `edge_replay_records` 建立可索引的顾客
主体归属与 `pii_purged_at` 语义。匿名化在同一 SECURITY DEFINER 事务内递归锁定 canonical group，
并依次：

1. 拒绝仍有 draft/open 订单或 queued/printing PII 打印快照的主体组；
2. 删除关联未完成/历史确认卡及其冻结参数；
3. 把幂等和 replay 的 PII 结果替换为无 PII 终态，保留请求 hash、envelope hash、decision 和时间；
4. 清除关联 audit JSON 的直接 PII，只保留命令、主体 id、操作者、来源门店、时间与
   `privacy_redacted` 证据；新写入从源头禁止姓名/地址/标识/备注进入普通 audit；
5. 清除 canonical group 全部门店订单快照、终态打印快照、profile 服务备注、全部 active/retired
   地址正文/联系人/电话及标识 raw/normalized 值，以及支付、衣物、履约和会员权益的主体备注；
6. 最后匿名化全部 group customer 行并追加 privacy event 与总线审计。

订单、会员账户和衣物保留不可逆 `customer_pii_purged_at` 锚点。其后即使已知 opaque id，支付退款、
会员资金/等级/积分/权益、履约日志、确认卡、幂等/replay、审计、打印或照片写入也只能保存固定
`privacy_redacted`/NULL，或以 `CUSTOMER_ERASED` 终态拒绝；不能在一次性清理完成后重新写回姓名。
多主体通知清单按 `order_ids[]` 整体清除缓存，权益结果按 `benefits.customer_id` 归属主体。

既有 `garment_photos` 及其私有文件是终态订单的受限运营/理赔证据，不是“后置”的顾客档案头像。
本阶段匿名化切断姓名、手机号、备注与顾客检索，但不物理删除已经存在的衣物照片；privacy status
与 export v2 分别披露保留数量，且匿名化后禁止新增照片。系统不得宣称这些文件已经物理擦除；
访问继续要求认证、门店和订单权限，有限保留期、备份到期及可审计物理删除 worker 由独立
retention policy 冻结。

任一步或最终审计失败都整笔回滚。应用角色继续不能任意 UPDATE/DELETE audit/replay；只有该窄化
R5 privacy 函数可做有记录的字段级 purge。历史 `customer.upsert` 审计中的姓名由 0051 一次性
窄范围清除并留下不含 PII 的 migration 维护证据。确认卡除事务内主体清理外，还必须有启动和
周期性有界 retention worker，不能只等下一张卡创建时顺便删除。

### 4. HMAC 擦除墓碑阻止离线 PII 复活

0051 用 owner-only `customer_phone_history` 记录每次客户插入/换号的 keyed HMAC、opaque customer id
与首次/末次时间，不保存历史明文。手机号更新与匿名化共享组织级 phone advisory lock；匿名化前
为 canonical group 的全部历史 HMAC 写入组织级 `customer_erasure_tombstones`。墓碑只保存
由每组织私有随机 key 计算的 HMAC-SHA-256、原 opaque customer id、`erased_at` 和服务端操作者，
不保存明文手机号。HMAC key 位于仅数据库 owner 可读的 `customer_privacy_hmac_keys`；应用角色只
能调用窄化的 SECURITY DEFINER 检查，不能读取 key 或枚举 tombstone。

`customers.phone` 的数据库 trigger 是回滚兼容的最终门禁；当前 memory/PG repository 也在
`customer.upsert/update` 和订单顾客解析前检查，以返回专用、不可重试的 `CUSTOMER_ERASED`。因此
匿名化前排队的 `customer.upsert`、`order.receive` 或 `order.hold` 恢复后只写一条无 PII replay
终态，Edge 自动 ack 并安全删除本地密文队列项，不会新建顾客或订单。

trigger 必须先核对服务端 `app.org_id` 与 `NEW.org_id` 一致，再检查本租户 tombstone；跨租户写入
无论目标号码是否已擦除都返回同一 tenant failure，不能借 BEFORE trigger 与 RLS 的执行顺序形成
一比特 tombstone oracle。数据库 owner 的无 GUC 维护路径仍受 HMAC tombstone 门禁。

同号重新建档本阶段失败关闭。未来只能由 privacy-admin 的显式 re-enrollment ADR 清除墓碑；
普通 staff、旧应用或离线 replay 永远不能自行解除。离线设备在重连前仍可能持有加密队列副本，
隐私结果必须如实报告 eventual edge purge 边界，不能声称服务端能远程擦除断电设备。

0028 已匿名化的历史行只剩 `anon-*`，0051 无法从数据库恢复其旧手机号 HMAC。因此升级事务会撤销
仍可承载 `customer.upsert/order.receive/order.hold` 的旧 offline grant、释放关联 Primary lease 并
清空当前 lease head；旧密文队列只能失败关闭并由设备安全丢弃/重新 commissioning。0051 之后新
authority 才进入有完整 phone-HMAC 历史的 epoch，不能让旧授权跨越隐私迁移边界。

### 5. 顾客与等级折扣统一使用整数基点

`customer.discount_policy.set`（R4、`order_discount`）用同一 profile version CAS 设置
`discount_bps: null | 0..10000` 并要求原因：

- `null`：没有顾客覆盖，允许继承有效会员等级；
- `0`：显式不折扣，并阻止继承等级折扣；
- `1..10000`：顾客专属折扣比例。

该政策是组织级且适用于组织内所有门店，符合现有 org-scoped customer/tier 与活动架构的
`fixed_discount_pct`；门店独立规则、品类排除和 campaign 后置。ADR-41 的 tier 定义增加
`discount_bps`，会员分配时把该值冻结进 `member_memberships`。后续修改 tier 不重估已分配会员；
到期等级不参与计价。

自动优惠只作用于 `original_cents`：

```text
discount = floor(original_cents × discount_bps / 10000)
payable  = original - discount + addon + urgent + freight
```

计算使用整数/BigInt 中间值后回到安全整数分，不用浮点比例。优先级固定为：非零管理员手工固定
金额 > 顾客覆盖（含显式 0）> 未到期会员等级快照 > 无折扣。客户端不能提交基点、来源或计算后
金额来冒充自动政策。

### 6. 订单冻结政策与运营豁免快照

`order.hold` 和 `order.receive` 在同一总线事务中先解析 canonical customer，再共享锁读取
profile/会员快照、服务端计算折扣，最后写订单。订单冻结 profile version、折扣来源、折扣基点、
会员/tier 版本和三个运营豁免。已有 draft 转 open 时按确认时当前政策重新计价；已
open/closed/cancelled 历史永不因 profile、tier 或政策变化被重估。

顾客/等级自动折扣与优惠券不叠加：自动折扣大于 0 的订单继续不满足 ADR-41 的券核销前提；
管理员手工折扣同样不叠加。若未来需要“取最优”或复合活动，必须由营销 ADR 冻结顺序与对账，
不能让浏览器自行比较。

打印与上挂只读取订单快照，不读取顾客当前值：跳过取衣单时拒绝为该订单新建 XP-58 根任务，
跳过标签时拒绝新建 DL-206/GP-3120 根任务，跳过挂点时拒绝 `garment.rack.assign`。已合法创建的
不可变打印任务仍按既有 retry/reprint 语义处理，避免后来改档案篡改历史打印权威。
Web 收到服务端冻结的 `skip_ticket_print=true` 后也不得调用任何 host 自动打印 callback；按钮禁用
只是 UX，不能作为豁免执行边界。

本阶段不扩大 offline grant。无 profile/会员政策的普通离线订单继续既有语义；若 replay 时发现
会影响金额、打印或上挂的非默认 profile/有效等级，则返回 `REPLAY_ARBITRATION_REQUIRED`，不能按
过期缓存或恢复时当前政策静默入账。将来只有签名 grant 明确携带版本化政策快照后才能取消该
失败关闭边界。

### 7. 契约、权限、AI、迁移与回滚边界

新增 2 commands / 1 query，冻结总面从 50/32 增至 **52/33**：

- commands：`customer.profile.set`、`customer.discount_policy.set`；
- query：`customer.profile.get`。

三者均 online-only；profile query 明确不进入 AI。顾客 AI 投影改成逐条安全 allowlist，不能再把
整个 customer query 集合展开后意外暴露 `customer.get/privacy.*/profile.get`。既有 customer
read/write 命令补 `customer_read/customer_write`，`customer.update` 增加 version CAS；同批更新
freeze、OpenAPI、CHANGELOG 与验收记录。

expand-only `0051_customer_extended_profiles.sql` 新增 profile/address/identifier、HMAC key、phone
history 与 erasure tombstone 表，并给 customer、tier、membership、orders 及三类通用持久化表增加兼容列。
旧代码忽略新列和新表仍可读取；数据库 phone trigger 让旧写入在 tombstone 上失败关闭。非
`LOCAL_PROFILE` 的 customer surface 在 repository 完成 request-scoped org 改造前继续 404，不能
因新增 UI 顺手扩大多店攻击面。

## 验收

1. Contracts 严格拒绝未知字段、重复/超限地址标识、多个默认地址、非法基点、陈旧 version；
   freeze 为 52/33，profile/private privacy query 不进入 AI。
2. 真实 PostgreSQL 证明两组织/两门店 RLS、缺 GUC、child FK、A→B→C、跨门店 source 订单、
   合并并发、合并组总量门禁、CAS、活动标识唯一、retire purge 与完整 export/anonymize；内存实现
   同样证明超限合并零副作用、全组 profile 导出和匿名化清理。
3. 匿名化同事务清理 audit/idempotency/pending/replay/profile children 与全部关联叙述；任一注入
   失败全部回滚。旧号换新号后两者都不能复活 PII；旧 epoch authority 被撤销，0051 后 Edge 对
   `CUSTOMER_ERASED` 终态自动 ack。
4. 内存与 PG 证明 tier snapshot、折扣优先级/整数取整、订单历史不重估、券不叠加、打印/上挂只
   读订单快照，以及非默认政策 offline replay 进入仲裁。
5. Web 顾客页可维护扩展档案与 R4 折扣，等级设置显示折扣；开单结果明确显示自动折扣来源与
   运营豁免。Browser 用纯合成地址/车牌完成保存、检索、开单与拒绝路径。
6. migration apply/replay、workspace、独立隐私/计价安全复核、PR/精确 SHA CI 和 hk-vps Cloud
   验收继续分层，软件本地完成不等于已发布。

## 后置

- 法律条款模板、顾客本人电子签名、签名设备、证据时间戳与合同撤回；
- privacy-admin 手机号 re-enrollment 与号码回收治理；
- 地址地理编码、地图、真实取送调度、车辆 VIN/政府证件/扫描件和顾客照片；
- 自动升降级、品类折扣、多个政策叠加、最优价比较与复杂营销 campaign；
- 版本化 signed offline profile/pricing grant；
- 新 Web 字段的 Electron/Runtime/实体打印同步适配继续属于阶段 5 独立门禁。

## 否决的备选

- **把店员勾选当顾客法律签名**：不可证明签署主体与文本，否决。
- **客户端提交百分比或自动优惠金额**：可伪造收入让利，否决。
- **修改 profile/tier 后重估历史订单**：破坏订单和报表快照，否决。
- **profile 替换时保留退役地址/标识正文**：造成导出漏项和长期 PII，否决；退役行只保留无 PII
  的结构证据。
- **只按当前 customer id 或直接 source 匿名化**：会遗留跨店/多跳 PII，否决。
- **只清当前数据库行、不处理幂等/replay/离线队列**：匿名化后仍可泄露或复活 PII，否决。
- **使用无 key 的手机号摘要**：11 位手机号可枚举反推，否决。
