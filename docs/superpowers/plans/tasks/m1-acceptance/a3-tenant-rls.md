# A3 验收单：租户矩阵、三元键与 RLS SQL 契约

> 状态：**contract-only 冻结候选**　日期：2026-07-21
> 依据：[ADR-02](../../../../adr/2026-07-19-adr-02-postgres-multitenancy-rls.md)、
> [架构 §4/§7](../../../specs/2026-07-19-laundry-v2-architecture.md)、
> [M0-1 验收单](../m0-acceptance/m0-1-rls.md) 与
> [M0-1 SQL 底稿](../../../../../tools/spikes/m0-1-rls/sql/policy-templates.sql)

## 1. 范围与非结论

A3 只冻结 `@laundry/contracts` 的表作用域、组合键描述/校验和 SQL 文本生成语义。它不连接
数据库、不执行 migration、不创建角色、不注入 GUC，也不宣称生产 RLS 已完成。C2 必须把模板
落到正式 PG schema，并分别实证 `laundry_app`、owner/maintenance、worker 和五类旁路行为。

本项从 M0-1 提取已经验证过的语义，但不复制 spike 的 evidence 标签或把 M0 环境结果冒充生产证据。

## 2. 可执行断言

从仓库根目录执行，任一命令非零即判 A3 未通过：

```bash
pnpm --filter @laundry/contracts test -- tenant-table-matrix
pnpm --filter @laundry/contracts test -- tenant-keys
pnpm --filter @laundry/contracts test -- rls-templates
pnpm --filter @laundry/contracts test
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/contracts lint
git diff --check
git diff --exit-code -- package-lock.json pnpm-lock.yaml
```

测试必须直接断言真实导出 API，并覆盖：

- 架构 §7 的 53 张表恰好一次落入 global/org/store；未知表抛错，矩阵与条目均不可变；
- `automation_policies.store_id?` 仍是 org scope，不能因可选过滤误套 store policy；
- 唯一键校验只接受架构显式声明的 `orders` 与 `order_lines` 布局；不能从 store scope 推断
  `primary_lease_heads` 等表含 `(org_id, store_id, id)`；
- `garments -> order_lines` 精确为四列对四列，缺 `order_id`、乱序、重复列、长度不等或跨 parent
  布局全部拒绝；外键校验只接受订单链三条显式映射，其他 pair 即使形状合理也拒绝；
- org/store SQL 同时含 ENABLE、FORCE、USING、WITH CHECK，输出重复调用完全一致；builder 只能
  接收矩阵中对应 scope 的表，mismatch、global 或未知表全部拒绝；
- 缺失/空 GUC 使用 `NULLIF(current_setting(..., true), '')::uuid` fail-closed，谓词没有跨表子查询；
- schema/table/policy/role 的注入、大小写、点号和超过 63 字节的 ASCII 标识符均拒绝；
- maintenance policy 只 `TO laundry_owner`，任何其他语法合法角色也拒绝，并同时含
  `USING (true)` / `WITH CHECK (true)`。

## 3. RED → GREEN 证据要求

初始三轮测试都必须先因对应模块/API 缺失而 RED；审查修正继续分别以 non-owner allowlist、
scope mismatch/global/unknown、未声明键布局负例观测 RED，再写最小实现并运行同一 focused 命令
到 GREEN。不能以拼写错误或恒真 shell 代替。最终结论只引用新鲜的全量
test/typecheck/lint/diff 输出。

## 4. ADR-02 / M0-1 映射

| 契约项                           | ADR-02                      | M0-1 底稿                     | A3 边界                          |
| -------------------------------- | --------------------------- | ----------------------------- | -------------------------------- |
| 三类作用域矩阵                   | #1、#8                      | 三表仅验证 store 模板         | 穷举 §7 当前 53 张表             |
| 三元/四元组合键                  | #8                          | `schema.sql` 订单/行/衣物约束 | 仅接受三条显式订单链映射         |
| org/store RLS                    | #2、#9、#10                 | `policy-templates.sql`        | 生成 scope-bound 确定性 SQL      |
| missing/empty GUC fail-closed    | #10                         | 五类旁路读写实测              | 冻结 `NULLIF(current_setting())` |
| owner maintenance policy         | FORCE RLS 与独立 owner 后果 | M0-6 后续补出的 owner 修正    | 仅允许 canonical `laundry_owner` |
| 正式 migration / 角色 / 旁路门禁 | ADR-02 的 M1 生产要求       | spike 证据不能替代生产        | **不在 A3，留给 C2/P4**          |
