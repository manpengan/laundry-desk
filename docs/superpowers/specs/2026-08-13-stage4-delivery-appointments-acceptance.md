# 阶段 4.4 Item 2 顾客取送预约、改期与取消验收记录

> 日期：2026-08-13
> 状态：**本地实现候选、focused 门禁与定点真实 PostgreSQL 不变量已完成；Browser、全仓、CI 与发布未执行**
> 决策：[ADR-47](../../adr/2026-08-13-adr-47-customer-delivery-appointments.md)（Proposed，待 manpengan 签署）
> 前置提交：Item 1 `68cb640e4b633359a35ae56727798afb73dac150`（本隔离工作树等价 cherry-pick `e7b346d`）
> 实现基线：`458f08b2d9e0e7e23d05dc997b49017860d471f2`

## 1. 范围

本记录只覆盖当前认证门店内，员工从顾客详情使用顾客已有地址创建取件/送回预约、原子改期和受控
取消。创建/改期在服务端重新校验 feature、策略版本、地址归属、时间规则、重复与实际每格容量；
取消保留历史并在 feature/policy 暂停时仍可释放容量。

不包含顾客本人认证、小程序/公开自助入口、地址新增/地理编码、任务分派、司机接单、路线、GPS、照片、
签名、通知、离线/Edge 或第三方 provider。本记录形成时 `delivery_order` 尚未实现；该历史结论后由
[ADR-48](../../adr/2026-08-13-adr-48-authoritative-delivery-orders.md) 与 Item 3 验收记录推翻，不回填为
Item 2 证据。

## 2. 关闭矩阵

| 层级             | Item 2 目标                                                     | 候选状态                                      |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------- |
| ADR/Contracts    | 3 commands + 3 queries、62/43、R3/R2、严格边界、非 AI           | 已实现；ADR 待产品签署                        |
| Schema/RLS       | 0055 预约容量、组合外键、FORCE RLS、禁物理删除、不可绕过状态机  | 静态 focused 与应用角色定点真实 PG 不变量通过 |
| Server           | memory/PG、canonical 地址、真实容量、原子改期、取消、审计、幂等 | focused 单元/HTTP/typecheck/build 已通过      |
| Web              | 专用 canonical 地址查询、预约/改期/取消、R3 确认、feature 降级  | focused model/page 与 production build 已通过 |
| Privacy          | 只存 opaque ID、地址最小投影、不复制电话/姓名、审计绑定顾客     | 契约、迁移与 handler/真实 PG 负向断言已覆盖   |
| External/release | 同槽真实并发、完整 RLS/Browser、顾客自助、配送任务、生产发布    | 明确非范围或后续 exact-SHA 门禁，未宣称已交付 |

## 3. 不可替代的验收证据

- ADR-46 报价可用不等于名额已锁；只有 `delivery.appointment.create` 事务成功才形成容量占位。
- memory 容量测试不等于 PostgreSQL 同槽并发安全；必须另行证明 advisory lock 下不会超卖。
- Web 显示的 canonical 地址不等于预约表保存了地址；迁移、审计和事件必须保持只有 opaque ID/运营快照。
- 创建成功本身不等于已产生 `delivery_order` 或配送任务；后续 Item 3 已新增独立配送订单状态机，
  预约仍不会自动冒充配送订单或任务。
- 取消成功只释放预约容量，不代表退款、通知或任务撤回；本轮不存在这些副作用。
- UI feature gate 不是授权边界；命令总线权限、会话租户和数据库 FORCE RLS 必须分别成立。
- focused test/build 不等于 required CI、真实 Browser、合入或 hk-vps 发布。

## 4. focused 行为矩阵

### 4.1 Contracts 与 Web model

- 创建只接受顾客/地址 ID、方向、区域、绝对开始时间和策略版本；拒绝 org/store、地址正文、运费和容量。
- 改期同时携带预约和策略 expected version；方向、区域与顾客归属从权威预约读取。
- 取消只接受五个 reason code；不接受可能含 PII 的自由文本。
- get/appointment-list/address-list 均为 PII/PII-linked R2；预约列表默认 50、两种列表最多 100，六项
  全部 online-only 且不进入 AI 清单。
- 地址列表不用单行 `customer.profile.get` 推断权威归属；专用查询通过 `customer_canonical_group` 合并
  根档案与来源档案的有效地址，仅返回 label/address/is_default，并去掉 recipient/contact phone。
- Web 使用 Contracts schema 构造输入、解析权威列表；feature-off/策略暂停时禁止新建和改期但保留列表与取消。
- ADR-47 把 `delivery.policy.get` 的只读权限修订为 `delivery_read`，使柜台员工能读取区域和版本；R5 写策略仍仅管理员。

### 4.2 数据库与 Server

- 预约行按 org/store/customer/address/staff 租户组合外键约束；地址与顾客 canonical group 的归属在命令事务内锁定验证；状态、时间、整数分、版本与取消三联状态在 DB 校验。
- FORCE RLS 同时校验 org/store GUC；`laundry_app` 无 DELETE/TRUNCATE；表不含地址、电话、坐标或自由文本列。
- 0055 write guard 对应用角色强制 `scheduled → scheduled | cancelled`、`version + 1`、单调数据库时间、
  取消终态与身份/创建字段不可变；直接 UPDATE 不能复活取消预约或借改期篡改地址。
- 创建事务锁定门店时区、策略/feature、地址与目标时隙，在锁内按 canonical 顾客组判断重复并计数，成功后保存费用/策略快照。
- 改期锁定预约行并按排序后的 key 锁定旧/新槽；失败保留旧槽，成功只增加一次版本。
- 取消只允许 scheduled → cancelled，feature-off 仍可执行；重复/旧版本/跨顾客失败关闭。
- 三写经 R3 冻结卡和持久幂等重放；预约、审计与领域事件复用同一命令事务。
- 六条路由均使用 delivery 专用摘要限流器，按 session/org/store/kind 分桶并在领域访问前拒绝。

## 5. 新鲜证据

以下是同一 Item 2 候选工作树的新鲜 focused 证据，未执行用户已明确免除的全量回归：

- `@laundry/contracts`：专项 4 files / 22 tests 通过，并通过 typecheck/build；冻结精确 62/43。
- `@laundry/db`：专项 4 files / 71 tests 通过，并通过 typecheck/build；包含 0055 inventory、expand-only、
  schema/RLS 与数据库 write guard 静态门禁。
- `@laundry/server`：预约/policy/address resolver/PG store/runtime/HTTP 限流专项 36 passed + 1 skipped
  通过，并通过 typecheck/build；
  首个 nullable quote 类型错误已保留后按 guard 构造精化副本修复。
- `@laundry/web`：appointment model/顾客页/policy/设置专项 18 tests 通过，并通过
  typecheck/production build；Vite 保留既有主 chunk 超过 500 kB 的非阻断警告。
- 隔离临时 PostgreSQL 16 上 `0054 → 0055` apply 至 55 条正式迁移；应用角色定点 1/1 通过，覆盖
  canonical A+B 地址列举/来源地址预约、身份/创建字段不可变、版本必须逐次增加、数据库时间盖章、
  合法改期/取消与 cancelled → scheduled 复活拒绝；容器、网络、配置和带 owner 标签的临时卷已清理。
- 迁移头识别与 Cloud release catalog 的隔离链单测随 `0054 → 0055` 更新，6 tests 通过。
- 所有本次触及的 TS/TSX/MJS 通过 focused ESLint；production 文件均低于 400 physical lines，测试文件
  均低于 800 lines；`git diff --check` 通过。

本记录**不证明**完整真实 PostgreSQL RLS/同槽并发、fresh browser、workspace 全量、required CI、合入、
hk-vps 迁移/发布、顾客本人自助或配送任务。定点真实 PG 证据只覆盖上述 canonical 地址与数据库状态机，
其余必须在后续集成/发布阶段以 exact SHA 另行取证。

## 6. 完成判定

Item 2 代码候选只在上述 focused 结果属于最终工作树、ADR-47 与冻结面一致、所有生产文件低于 400 行、
测试低于 800 行且恰好形成一个 Item 2 commit 时可交给父任务集成。只有后续完整真实 PostgreSQL/Browser、
required CI、合入、发布和公网验收都绑定最终 exact SHA，才可把“生产已发布”写入本记录。
