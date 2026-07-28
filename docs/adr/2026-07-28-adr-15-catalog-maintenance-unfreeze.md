# ADR-15：解冻价目写入，补齐首期价目维护

- 日期：2026-07-28
- 状态：**Accepted**
- 决策者：manpengan
- 路线：[ADR-14：通用 V2 本地优先交付](2026-07-25-adr-14-generic-local-first-v2-delivery.md)
- 影响契约：`packages/contracts` v0.2 M2 冻结面

## 背景

2026-07-28 补真实 PostgreSQL 柜台工作日验收时暴露一个交付级缺口：

**全新安装无法开单。**

`order.receive` 采用服务端权威计价——客户端传的价格被丢弃，服务端按
`(service_code, category_code)` 在在架价目中查找，要求**恰好命中一条**，否则拒绝
下单（`resolveServerPrices`）。而：

1. 迁移不种任何 `catalog_items` 数据；
2. 一次性 bootstrap 也不种；
3. 冻结的 v0.2 M2 契约面**只有 `catalog.items.list` / `catalog.items.get` 两条查询，
   没有任何写入命令**。

三者叠加的结果是：装完软件价目表为空，任何开单都失败，且**没有任何受支持的途径
把价目补进去**——只能绕过应用直接写库。浏览器工作日 E2E 正是靠
`tools/local/seed-counter-catalog.mjs` 直接写库才跑得起来，这本身就是缺口的证据，
不是可接受的产品形态。

ADR-14 第 5 条把「顾客查询/建档、开单、权威计价」列为首个里程碑。权威计价没有价目
就不成立，因此价目维护属于首期范围，不是后续能力。

## 决策

### 1. 解冻：新增且仅新增一条写入命令

在 v0.2 契约面新增 `catalog.item.upsert`，按稳定 `code` 幂等 upsert 一条价目。

不新增删除命令。停用价目走 `is_active=false`（软停用），保持既有订单的可追溯性，
也避免删除掉仍被历史订单引用的口径。

### 2. AI 投影保持只读

`M2_READ_ONLY_AI_DEFINITIONS` 当前展开 `CATALOG_SKELETON_DEFINITIONS`，其用例断言
「每一条都是 query」。因此新命令**不得**进入 `CATALOG_SKELETON_DEFINITIONS`。

新增独立的 `CATALOG_COMMAND_DEFINITIONS`，只并入命令面与 `M2_CONTRACT_DEFINITIONS`，
**不并入 AI 投影**。ADR-05 的「AI 首期只读」裁决不因本 ADR 松动。

### 3. 风险等级定为 R2，不强制二次确认

价目单价影响未来订单的计费，但**不影响已存在的订单**：`order_lines.unit_price_cents`
与 `orders.original_cents` 等是开单时刻的不可变快照（迁移 0019 明确为
"immutable price snapshot components"）。改错价目只影响后续开单，且改回即可修复，
不产生不可逆的资金后果。

因此不套用 R3 二次确认，与同为主数据维护的 `customer.upsert`（R2）保持一致。
访问控制由 `rbac.settings_admin` 承担——与 `platform.settings.set` 同一口径，
店员不可改价。

`offline_mode` 为 `denied`：不允许离线改价目，避免离线期产生互相冲突的价目版本。

### 4. 不新增迁移

`catalog_items` 表、`catalog_items_store_scope` RLS 策略（`FOR ALL`，带
`WITH CHECK` 租户约束）与 `GRANT SELECT, INSERT, UPDATE, DELETE ... TO laundry_app`
在迁移 0008 已就位。本 ADR 只解冻契约与补齐命令/UI，不动 schema。

### 5. 种子数据不进产品路径

不在 bootstrap 里塞一份「默认价目」。不同洗衣店的服务与价格没有通用默认值，
硬塞会变成又一处需要清理的产品硬编码（ADR-14 后果第 3 条已要求移除此类硬编码）。
首期由店主在设置页自行录入。

原先为跑通浏览器工作日 E2E 而写的 `tools/local/seed-counter-catalog.mjs`
（直接写库）随本 ADR **删除**：E2E 改为走设置页录入价目，从而每次都真实验证
「全新安装 → 录价目 → 开单」这条路径本身。测试不再需要绕过应用写库。

## 后果

- v0.2 命令面由 14 条增至 15 条，`m2-freeze.test.ts` 的冻结清单与 OpenAPI 快照
  同步更新。**这是一次有意解冻，不是冻结失效**：后续新增仍须走 ADR。
- 设置页新增价目维护区，店主可新增/改价/停用。
- 全新安装的可用路径变为：登录 → 设置页录入价目 → 开单。
- `catalog.items.list` 的 `max_result_rows: 200` 未变，价目规模上限仍是 200 条。

## 否决的备选

- **bootstrap 内置默认价目**：与通用产品裁决冲突，见决策第 5 条，否决。
- **把 upsert 并进 `CATALOG_SKELETON_DEFINITIONS`**：会把写命令暴露进 AI 投影，
  破坏 ADR-05 的首期只读裁决，否决。
- **定为 R3 强制确认**：与不可变价格快照带来的实际影响面不匹配，且会让日常改价
  变重；同类主数据 `customer.upsert` 亦为 R2，否决。
- **提供 `catalog.item.delete`**：删除仍被历史订单引用的口径会损害可追溯性，
  软停用已满足需求，否决。
- **继续靠直接写库**：不是产品形态，且要求店主具备数据库访问权限，否决。
