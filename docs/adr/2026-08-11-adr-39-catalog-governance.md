# ADR-39：Cloud 价目治理、排序与审计闭环

- 日期：2026-08-11
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-15：价目维护解冻](2026-07-28-adr-15-catalog-maintenance-unfreeze.md)、[ADR-16：契约面门禁](2026-07-31-adr-16-edge-operations-scope-ratification.md)、[ADR-37：Cloud Web 主交付](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 影响：价目契约、PostgreSQL `catalog_items`、设置页、审计投影、hk-vps 发布

## 背景

ADR-15 关闭了全新安装无法录入首条价目的缺口，但设置页只读取在架行：停用后无法恢复，
`sort_order` 没有用户入口，并发编辑会最后写入者覆盖。通用审计查询只返回“有差异”标志，
操作员也无法按价目编码确认新增、改价、停用、启用与排序动作。

历史订单已经保存开单时刻的服务端单价与金额快照，本阶段必须保留这个边界；目录治理不得
重估既有订单。

## 决策

### 1. 活动读面与管理读面分离

保留 `catalog.items.list/get` 的版本与语义，开单和只读 AI 仍只能看当前在架价目。新增：

- `catalog.items.manage.list`（R1 + `settings_admin`）：返回当前认证门店的在架/停用行、排序号、
  单调版本与更新时间；客户端不能指定组织或门店；
- `catalog.audit.list`（R2 + `audit_read`）：按有界时间窗与可选 code 返回 catalog-only 安全
  投影，只含时间、员工、动作和 code，不返回 `before_json`、`after_json` 或凭据内容；窗口最多
  31 天，epoch 不超过 `9999-12-31T23:59:59Z`。

两条管理查询均不进入 `M2_READ_ONLY_AI_DEFINITIONS`。

### 2. 更新与启停使用乐观版本

`catalog.item.upsert` 升为 `0.3.0`，增加可选 `expected_version`。新 Web 创建时发送 0，更新、
停用和启用时发送管理列表读到的当前版本；不匹配返回 `IDEMPOTENCY_CONFLICT`。为迁移期间的
旧客户端保留“未提供版本”兼容，但新 UI 不走该降级路径。

新增行在未指定 `sort_order` 时追加到当前目录末尾；更新未指定时保留既有排序。停用仍为软
下架，稳定 code 不删除；停用行可通过同一命令带当前版本重新启用。

### 3. 排序只接受完整在架快照

新增 `catalog.items.reorder`（R2 + `settings_admin`），输入是最多 200 行的完整在架
`{code, expected_version}` 顺序。服务端在同一事务中锁定门店价目，拒绝重复 code、缺行、
多行、停用/启用竞态或任一版本漂移，再原子写入连续排序号。命令不进入 AI 或离线面。

价目 upsert 与 reorder 共用门店级事务 advisory lock，业务变更、版本增长与 `audit_log` 仍在
命令总线同一事务中提交。

### 4. 版本由数据库触发器维护

新增纯扩展迁移 `0048_catalog_governance.sql`：

- `catalog_items.version integer NOT NULL DEFAULT 1`，并约束为正数；
- 撤销 `laundry_app` 从 0008 继承的 `DELETE`/`TRUNCATE` 权限，物理清理由数据库 owner
  的测试/维护边界承担，产品命令只能软下架；
- `BEFORE UPDATE` 触发器只在名称、服务/品类、整数分单价、助记码、启停或排序变化时把版本
  设置为 `OLD.version + 1`；仅更新时间变化不增长；调用者不能直接篡改版本。

0047 代码会忽略新列，既有 INSERT 使用默认值，既有 UPDATE 经触发器自动增长，因此
`0047 -> 0048` 标记为旧代码兼容；失败切换允许保留 0048 数据库而回到 0047 代码。

### 5. 契约冻结

本 PR 明确修改 `packages/contracts/test/m2-freeze.test.ts`：

- command 新增 `catalog.items.reorder`，总数 42 → 43；
- query 新增 `catalog.items.manage.list`、`catalog.audit.list`，总数 27 → 29；
- `catalog.item.upsert` 版本 0.2.0 → 0.3.0；
- 新管理面不扩大只读 AI 工具投影。

## 验收

1. 契约负例、RBAC、重复/不完整排序与陈旧版本失败关闭；
2. 真实 PostgreSQL 证明新增、并发 CAS、改价、排序、停用、启用、版本单调、禁止应用物理删除、
   审计同事务及跨店隔离；
3. Browser 证明设置页显示在架/停用状态、并发陈旧编辑刷新、上下排序、停用后恢复、安全审计
   列表和改价后历史订单快照不变；
4. 完整 `workspace-check`、required `real-postgres`、精确 merge-SHA 主干 CI；
5. hk-vps 迁移到 0048，API 与 Cloud Chromium、catalog golden、marker/health/清理全部新鲜通过。

## 后果

- 停用价目第一次能从产品界面安全恢复，目录顺序成为服务端真源，并发覆盖会显式失败。
- 审计 UI 不需要扩大通用 PII 审计接口，也不会把原始 JSON 暴露到浏览器。
- 每次真实业务变化都会增长版本；排序完整快照最多 200 行，目录超过该界限需后续 ADR。
- 既有订单、支付和报表继续读取不可变订单快照，不因价目改价、停用或重排改变。

## 否决的备选

- **继续用活动列表维护**：停用即不可见、不可恢复，否决。
- **客户端逐行写排序**：中途失败会产生部分顺序且无法识别并发启停，否决。
- **把通用审计原文直接给 Web**：可能扩大 PII/凭据暴露面，否决。
- **数据库物理删除价目**：会破坏稳定 code 与历史可解释性，否决。
- **改价后重估历史订单**：违反订单价格快照与账务不可变边界，否决。
