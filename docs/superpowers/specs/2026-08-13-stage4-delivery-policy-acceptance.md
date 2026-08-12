# 阶段 4.4 Item 1 门店取送策略与不占位报价验收记录

> 日期：2026-08-13
> 状态：**本地实现候选、focused 与真实 PostgreSQL 门禁已完成；Browser、全仓、CI 与发布未执行**
> 决策：[ADR-46](../../adr/2026-08-13-adr-46-delivery-policy-and-policy-only-availability.md)（Proposed，待 manpengan 签署）
> 实现基线：`d37692c5cb6ab63699a9a647fa6f307270f1e17b`

## 1. 范围

本记录只覆盖当前认证门店的服务区域、整型分运费、每周时段、提前期、时隙、名义每格上限和
policy-only availability quote。策略可在 delivery feature 关闭时预先配置，但写策略不会打开该 feature，
关闭时的所有报价都必须返回不可预约。

不包含顾客自助身份、顾客地址、地理编码、精确坐标/围栏、容量占用、预约、改期/取消、任务、司机、路线、
GPS、移动 App、离线/Edge 或第三方 provider。

## 2. 关闭矩阵

| 层级             | Item 1 目标                                               | 候选状态                                      |
| ---------------- | --------------------------------------------------------- | --------------------------------------------- |
| ADR/Contracts    | 1 command + 2 queries、59/40、R5/R0/R1、严格边界、非 AI   | 已实现；ADR 待产品签署                        |
| Schema/RLS       | 0054 当前门店策略、FORCE RLS、有界 JSON、禁物理删除       | 静态与真实应用角色门禁已通过                  |
| Server           | memory/PG、乐观版本、审计、幂等、权限、时区报价、独立限流 | focused 单元/HTTP 已通过                      |
| Web              | 策略编辑、R5 复核、功能关闭提示、不占位报价               | focused model/page 与 production build 已通过 |
| Privacy          | 无顾客/地址/坐标/自由文本，当前门店会话注入               | 契约、迁移与处理器负向断言已覆盖              |
| External/release | 顾客自助、真实地址/地理、真实容量、生产发布               | 明确非范围，未宣称已交付                      |

## 3. 不可替代的验收证据

- 策略已配置不等于功能已启用；必须独立读取当前 `store_features.delivery`。
- `accepting_appointments=true` 不能覆盖 feature-off；关闭必须优先返回 `delivery_disabled`。
- 报价显示运费和时隙不等于名额可用；`capacity_status` 必须是 `not_checked`。
- 报价 `can_request_appointment=true` 不等于已占位、已预约或价格锁定；本轮没有任何预约写入。
- 浏览器的 `datetime-local` 只转换为绝对时间；是否命中服务时段以服务端门店时区为准。
- 区域 code/name 是有界门店运营标签，不是顾客地址、精确坐标、地理编码或可以自由扩展的备注。
- memory 通过不代表 PostgreSQL RLS 已验收；静态 migration 测试也不能替代真实应用角色/GUC 行为。

## 4. focused 行为矩阵

### 4.1 Contracts 与 Domain

- 严格拒绝未知字段、非小写区域 code、重复 code、越界数组/整数和客户端租户字段。
- 拒绝重叠时段、不足一格或不能整分的时段，且不就地修改输入数组。
- 冻结精确的 59 commands / 40 queries；一写两读都是 online-only、internal 且不进入 AI 面。
- feature-off 在已配置策略前失败关闭；其他不可用原因和可用时运费/结束时间可稳定重现。

### 4.2 数据库与 Server

- 每店只有一个当前策略；组织/门店/员工外键、JSON 数组长度、整数范围和 version 在数据库约束。
- FORCE RLS 同时校验 org/store GUC；`laundry_app` 无 DELETE/TRUNCATE，无迁移或 handler 写入会改动
  `store_features`。
- 同 expected version 首次创建/更新成功，旧版本失败；全局 command bus 保证同幂等键重放首次结果，
  同键不同输入失败。
- R5 首跳由服务端冻结完整策略摘要，另一管理员可核对版本、区域/运费、时段和全部预约规则；二次复核前
  不写策略或 audit，通过后策略、before/after audit 和领域 event 同事务提交。
- 0054 深层验证每个 JSON 对象的精确键、类型、金额和时段，并由数据库守卫固定 identity、版本 +1、
  会话管理员 actor 与数据库时间；应用角色不能用直接 SQL 写入畸形策略、跳版本或伪造操作者。
- 一写两读的独立限流使用摘要后的 session/org/store/kind，读写分桶，超限返回 `429` 和
  `Retry-After`。

### 4.3 Web

- delivery feature 关闭不隐藏策略配置，便于管理员先配置；但同页醒目提示所有报价不可预约。
- 区域最多 20、时段最多 28；整型、时间与策略组合在调用前经 Contracts schema 解析。
- 保存首跳使用完整输入，二跳只使用服务端 `confirm_ref` 和服务端冻结摘要；旧会话、旧门店、旧详情或旧
  报价响应均受 generation 隔离，不能覆盖当前编辑面或确认卡；成功后重新读取权威版本。
- 报价结果使用 Contracts result schema 重新解析，同时展示原因、门店时区、策略版本、运费和
  “容量未检查”。

## 5. 新鲜证据

以下是同一 Item 1 候选工作树的 focused 证据，未执行用户已明确免除的全量回归：

- `@laundry/contracts`：策略专项 4/4 通过，并通过 typecheck/build。
- `@laundry/db`：0054 专项 3/3 通过；migration/inventory/destructive/schema 静态门禁通过，并通过 typecheck。
- `@laundry/server`：策略 handler 5/5 通过；真实应用角色 invariant 1/1 通过；报价、PG store、HTTP 限流、
  runtime 注册/权限专项与 typecheck/build 通过。
- `@laundry/web`：确认卡、model/设置页专项 13/13 通过，并通过 typecheck/production build；Vite 保留既有
  主 chunk 超过 500 kB 的非阻断警告。
- 隔离 PostgreSQL 16 fresh `0001 → 0054`、bootstrap/readiness、应用角色写保护、Catalog chain、写闸和
  data-protection 全绿；0054 golden catalog 为 1265 entries /
  `0164edb4318816c3e7e42718e66311ecfcc6b26ec14c4a40dba2a801467c31d2`。
- 受触及的 production JS/TS/TSX 均低于 400 physical lines，测试文件均低于 800 lines；
  `git diff --check` 通过。

本记录**不证明** fresh browser、全仓回归、required CI、hk-vps 迁移/发布、
真实顾客地址、容量或预约。这些必须在后续集成/发布阶段以 exact SHA 另行取证。

## 6. 完成判定

Item 1 代码候选只在上述 focused 结果属于最终工作树、ADR-46 与冻结面一致、且 feature-off
负向行为仍通过时可独立提交。只有后续 Browser、全仓、CI、合入、发布和公网验收都绑定
同一 exact SHA 时，才可把“生产已发布”写入验收记录。
