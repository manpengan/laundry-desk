# ADR-45：店厂交接批次、清点差异与质检返工证据

- 日期：2026-08-12
- 状态：**Proposed（实现候选已落地，待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 领域基线：[ADR-03：件级衣物、订单与账务模型](2026-07-19-adr-03-garment-order-accounting-model.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、`0053`、Server fulfillment、Web 履约工作台、Cloud 合成验收

## 背景

当前通用 V2 已有件级 `received → washing → ready → racked → picked_up/delivered` 生命周期，
也能记录返工、异常、丢损和货架位置，但没有“哪批衣物由门店交给哪个工厂、双方每次清点了什么、
差异如何处理、回厂衣物是否质检合格”的权威证据。仅把衣物状态改成 `washing` 或 `ready` 无法回答
保管责任，也无法证明四次交接各自清点一致。

ADR-37 阶段 4.3 要求建立店厂交接批次、四节点扫码清点、差异阻断、质检和返工闭环。当前没有
独立工厂账号、跨组织租户协议、专用移动 App、离线扫描、照片/GPS 取证或真实工厂终端，因此本 ADR
只交付当前认证门店内部员工使用的 online-only Cloud Web 切片；响应式网页可在手机浏览器操作，
但这不等于外部工厂或实机移动端已经验收。

## 决策

### 1. 保管链与衣物生命周期分离

ADR-03 的 `garments.status` 继续是衣物加工/取衣生命周期的唯一真源。店厂四节点不新增
`store_dispatch`、`factory_receive` 等 garment status，而由独立批次状态和
`garments.custody_state` 表达保管责任：

| 当前批次状态         | 下一交接节点       | 推进后批次状态       | 匹配衣物保管状态 |
| -------------------- | ------------------ | -------------------- | ---------------- |
| `packing`            | `store_dispatch`   | `store_dispatched`   | `to_factory`     |
| `store_dispatched`   | `factory_receive`  | `factory_received`   | `factory`        |
| `factory_received`   | `factory_dispatch` | `factory_dispatched` | `to_store`       |
| `factory_dispatched` | `store_receive`    | `store_received`     | `store`          |

批次状态另有终态 `cancelled`。保管状态固定为
`store | to_factory | factory | to_store | exception`；manifest member 固定为
`active | exception | completed`，质检状态固定为 `pending | pass | rework`。

建批只接受当前门店、未关闭订单、衣物状态为 `received | reworked`、保管状态为 `store` 且不在其他
有效批次中的 1–100 件衣物。服务端在同一事务内重新验证全部集合，任何一件不合格就整批失败；
浏览器不能提交组织、门店、订单号、票号、衣物条码、客户信息或当前状态作为权威事实。

只有 `packing` 批次可取消。取消只释放 active manifest 回 `store` 保管，不删除批次、成员或审计
证据。已发生门店出库的批次不能用取消抹掉交接历史。

### 2. 四节点完整扫描与服务端集合运算

每个节点提交当前所见的完整 active manifest `garment_ids` 和本轮完整 `scanned_barcodes`，而不是
“新增一条扫码”。服务端先确认 garment id 集合精确等于同版本权威 manifest，再从数据库读取条码并
计算：

```text
matched    = expected ∩ scanned
missing    = expected - scanned
unexpected = scanned - expected
```

集合去重、排序、计数和摘要都由服务端产生；客户端不能上送 matched/missing/unexpected、批次状态、
保管状态或 `manifest_digest`。条码长度为 1–64，禁止 C0/DEL 控制字符；一次最多 100 个且必须唯一。

`missing = []` 且 `unexpected = []` 时，普通 R3 checkpoint 命令追加 attempt/checkpoint 证据并原子
推进批次与所有 active member。存在任一差异时只追加 immutable attempt，批次、manifest 和保管状态
保持原状，Web 以红色清单展示 missing/unexpected 并阻止下一节点。不能靠重复扫码、刷新页面或换
idempotency key 绕过差异。

### 3. R4 差异处置不会自动判丢

`fulfillment.handoff.discrepancy.resolve` 只针对当前批次的 latest discrepant attempt，要求另一位具备
`fulfillment_reconcile` 的 active admin 完成 R4 step-up。输入的 `garment_ids` 必须精确等于该
attempt 的 missing garment id；只有 unexpected 时数组必须为空。unexpected 条码绝不自动加入
manifest，也不能用客户端自报 id 认领。

受控原因固定为 `manifest_corrected | recount_verified | exception_accepted`。服务端锁内重算 attempt、
version、active manifest 和差异：匹配成员才推进到下一保管节点；missing 成员保留批次/衣物 anchor，
标为 `exception`，不会自动改成 garment `lost`；unexpected 只保留无客户信息的条码差异证据。
批次可以在明确隔离异常件后推进正常成员，异常件之后若确需判丢，仍必须单独执行既有
`garment.mark_lost` R4 命令及其赔付/原因边界。

差异处置是只追加 evidence；不能修改或删除原 attempt，也不能把一次旧 attempt 重用于新版本批次。

### 4. 工厂收件后的质检与返工

质检只在 `factory_received` 阶段执行，要求 `fulfillment_handoff + fulfillment_qc`。每批一次提交
1–50 件完整检查集合，`checks` 必须与 `garment_ids` 是同一集合：

- `pass`：原因必须为空，追加 QC evidence，并把该衣物生命周期推进到 `ready`；
- `rework`：原因必须是 `stain_remaining | damage_found | finish_incomplete | other`，追加 QC evidence，
  并把生命周期推进到 `reworked`。

返工件可在同一 `factory_received` 批次中重新质检；每次结果都只追加，当前 QC 状态取最新有效记录。
只有所有 active member 的最新 QC 为 `pass` 且 garment status 为 `ready`，才可记录
`factory_dispatch`。这使“已出厂”不能由客户端按钮跳过质检产生，也不把交接节点伪装成加工状态。

### 5. 契约面、风险、权限与确认摘要

新增恰好五条命令：

| 命令                                      | 基础风险 | 规模与额外权限                                    |
| ----------------------------------------- | -------- | ------------------------------------------------- |
| `fulfillment.batch.create`                | R3       | 1–100 件；>50 升 R4；`fulfillment_handoff`        |
| `fulfillment.batch.cancel`                | R3       | 仅 packing；`fulfillment_handoff`                 |
| `fulfillment.handoff.checkpoint.record`   | R3       | 1–100 件；>50 升 R4；`fulfillment_handoff`        |
| `fulfillment.handoff.discrepancy.resolve` | R4       | 0–100 个 missing id；另需 `fulfillment_reconcile` |
| `fulfillment.quality_check.record`        | R3       | 1–50 件；另需 `fulfillment_qc`                    |

新增两条 R2 查询：

- `fulfillment.batches.list`：最多 20 个近期批次，同时返回最多 100 件可建批衣物；
- `fulfillment.batch.get`：返回一个批次、最多 100 个 manifest member、四个 checkpoint、latest attempt
  的 matched/missing/unexpected 条码和最多 100 条 QC view。

两条查询都不返回顾客姓名、手机号、地址或服务备注，但票号、条码和内部 UUID 仍按 PII-adjacent
保守分类并受 store RLS、权限、结果脱敏和有界行数保护。五写两读全部 online-only，不进入 Edge
grant/primary lease、automation 或 AI 投影。冻结面从 **53/36 → 58/38**。

所有新写命令的确认卡使用服务端派生 `factory_handoff` 摘要，冻结 operation、批次/version、节点、
factory code、排序后的票号/条码安全清单、manifest/scan/difference/QC counts 和 SHA-256
`manifest_digest`，绝不包含客户姓名或手机号。二跳只提交 `confirm_ref`；锁内事实漂移则失败关闭，
必须重新首跳。

本轮同时关闭既有 `garment.bulk_transition`、`garment.rework`、`garment.incident.record` 和
`garment.mark_lost` 的 WYSIWYS 缺口。它们使用独立 `fulfillment_operation` 摘要，冻结排序后的 garment
id、服务端票号/条码、目标状态、事件类型、赔付金额及用户必须核对的原始 reason/note；自由文本以
garment subject 绑定清理，摘要不增加客户姓名或手机号。`garment.transition` 和
`garment.rack.assign` 仍是 R2，不纳入确认。

五条 mutation 还必须从已认证服务端会话取得 non-null device UUID；线路参数不接受 `device_id`，
也不能由浏览器自报或用 staff/session id 代替。会话没有受信设备身份时，建批、取消、checkpoint、
差异处置和 QC 全部失败关闭，不得写入任何交接/QC evidence。两条只读 query 不要求设备 UUID。

### 6. 数据库、租户、锁序与幂等

`0053` 新增或启用以下 store-scoped 表：

- `production_batches`、`batch_garments`；
- `production_handoff_attempts`、`production_handoff_attempt_items`；
- `production_handoff_checkpoints`、`production_handoff_discrepancy_resolutions`；
- `garment_qc_log`。

并为既有 `garments` 增加当前保管/active batch anchor。ADR-45 明确取代早期 tenant matrix 中
`production_batches` 可做 org 聚合的 contract-only 占位：当前所有批次和证据都必须同时带
`org_id + store_id`，启用并 FORCE RLS，应用角色不能绕过；跨店/跨组织工厂联邦没有被暗中实现。

批次 version、唯一 active anchor、状态/checkpoint 顺序、attempt/checkpoint/discrepancy/QC append-only、
租户复合外键和枚举 CHECK 在数据库层失败关闭。业务变化、证据和 audit 必须处于同一 PostgreSQL
事务；数据库证据时间只使用 PostgreSQL clock，应用/浏览器时间不能授权版本或排序。

涉及多个领域对象的写锁顺序固定为：

```text
order（按 id） → garment（按 id） → production batch → attempt/checkpoint/QC child
```

需要先定位批次的 handler 只做无锁读取，得到订单/衣物集合后按上述顺序加锁，再锁批次并完整复核
version/manifest；不能 batch → garment 反向加锁。所有数组先去重再按稳定 id 锁定，不用数据库重试
掩盖 `40P01`。

命令沿用 `(org_id, store_id, command, idempotency_key)` 持久幂等。同键同版本同参数只返回首次
结果，不重复追加 attempt、checkpoint、QC、status log 或 audit；同键不同参数失败。optimistic
`expected_version` 与确认 authority 都要在锁内复核，不能把 COMMIT 后响应丢失变成第二次交接。

五条写命令和两条 PII-adjacent 查询还必须经过进程内、按 session + org + store 分桶的独立限流；
写与读分别计数，超限返回 `429` 与 `Retry-After`，且限流发生在命令/查询的领域读取和 evidence 写入
之前。当前单实例 Cloud Server 下该门禁限制认证会话滥用；数据库的状态机、只追加证据与幂等约束
仍是最终一致性防线，不能用进程限流替代。

### 7. Feature gate 与交付边界

能力继续受当前门店 `fulfillment` feature 控制；关闭时五写两读都失败关闭，不能只隐藏 Web 菜单。
当前参与者都是同一组织、同一门店中已认证且被授予相应 permission 的内部员工。factory code 是
受控 ASCII 运营标识，不是可登录的外部租户、URL、密钥或网络目的地。

本 ADR 不交付：

- 独立工厂账号、外部工厂门户、跨店/跨组织工厂联邦；
- 原生移动 App、离线扫码、Edge replay、专用扫码枪或真实设备验收；
- 交接照片、签名、GPS、路线、司机、承运或第三方 webhook；
- 自动判丢、自动赔付、自动改 manifest，或以差异处置替代既有 R4 丢损流程；
- AI 读取/执行、自动化派单、营销、配送或 provider 接入。

## 验收

1. Contracts 精确冻结 58/38、五写两读、权限、PII redaction、R3→R4、online-only 与 AI 负向清单；
   `factory_handoff` / `fulfillment_operation` 确认摘要严格、不可变且无顾客身份。
2. Domain 穷举四节点状态机、终态/跳步拒绝、确定性集合差异和调用方数组不变性；garment lifecycle
   不新增交接状态。
3. `0053` 从空库 apply/replay，RLS/GUC/应用角色、复合外键、active anchor、枚举/version、只追加
   evidence、数据库 clock 与约束篡改均通过真实 PostgreSQL。
4. Memory/PG Server 覆盖建批资格、四节点、普通差异阻断、R4 missing/仅 unexpected、旧 attempt、
   重放、跨租户、锁序和 QC pass/rework/复检/出厂门禁；业务与 audit 同事务；五写两读逐一经过
   session + org + store 限流并在超限时返回 `429` / `Retry-After`。
5. Web 在窄屏完成建批、完整扫描、红色差异、另一管理员处置、QC/返工与批次证据读取；响应 parser
   使用 Contracts result schema，不手写宽松 JSON 断言。
6. fresh PostgreSQL、Browser/Cloud 合成旅程、workspace 全门禁、独立安全/数据库复核和精确资源清理
   均有新鲜证据；未授权的 commit、PR、部署和真实设备不得写成完成。

## 后果

- 门店可以区分衣物“加工到哪一步”和“目前由谁保管”，四次交接各有独立、不可覆盖的清点证据。
- 普通不匹配不会推进；R4 处置也只推进已证明匹配的衣物，并保留异常 anchor 供后续调查或独立判丢。
- 当前 store scope 简化了 Cloud Web 首期授权和 RLS；未来外部工厂/多店聚合需要新 ADR、主体模型和
  租户协议，不能直接放宽本表。
- 新增 PII-adjacent 运营引用扩大了受限查询面，但不新增客户姓名、手机号、照片、GPS 或 AI 投影。

## 否决的备选

- **把四节点加入 garment status**：混淆生命周期与保管责任，破坏 ADR-03，否决。
- **逐条扫码即改状态**：半批断电会留下无法证明的部分交接，否决；每个 checkpoint 必须完整集合。
- **客户端计算差异或摘要**：可漏扫、串批或篡改，否决；只接受服务端集合运算。
- **差异时普通 R3 继续推进**：无法明确保管责任，否决；必须阻断或由 R4 受控隔离异常。
- **missing 自动标 lost**：绕过赔付、原因和另一管理员复核，否决。
- **unexpected 自动入 manifest**：可能把其他批次/客户衣物串入当前批次，否决。
- **production_batches 保持 org scope**：当前没有跨店工厂主体和授权模型，会扩大可见性，否决。
- **先交付外部工厂登录或离线 App**：身份、同步、设备与支持证据尚未定义，否决并后置。
