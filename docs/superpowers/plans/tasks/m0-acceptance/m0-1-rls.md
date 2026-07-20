# M0-1 验收单 · RLS 三元租户隔离 + 性能（Codex）

> 产出目录：`tools/spikes/m0-1-rls/`　证据落点：`docs/research/2026-07-19-v2-m0-findings.md` §M0-1
> 依据：架构 §4/§7、ADR-02/03

## 目标

证明三元租户模型 + RLS 在约束层（而非口头承诺）杜绝跨租户/跨门店访问，且性能可接受。

## 前置

PostgreSQL 16（可用 M0-6 compose，或本地容器）；两租户两门店种子：orgA/storeA1、storeA2、orgB/storeB1，各灌数据。

## 步骤

1. 建最小表 orders / order_lines / garments：`UNIQUE(org_id, store_id, id)`；组合外键（garments→orders 三元；garments→order_lines **含 order_id** 四元）。
2. 全表 `ENABLE + FORCE ROW LEVEL SECURITY`；策略模板 org 级/店级各一，**USING 与 WITH CHECK 齐备**，仅比较本行列与 `current_setting('app.org_id'/'app.store_id')`。
3. 应用角色 `laundry_app`（NOBYPASSRLS、非表 owner）连接；owner 角色仅建表。
4. 实现事务级注入 `SET LOCAL`，含一个模拟队列 worker 路径。
5. 负向用例 + 约束用例 + 压测（见通过标准）。

## 通过标准（全部满足才算过）

| # | 用例 | 预期 |
|---|---|---|
| 1 | A 租户上下文查 B 租户/同 org 跨店数据（三表各测） | 0 行 |
| 2 | **GUC 未设置**执行查询 | 0 行（禁止报错放行或全量返回） |
| 3 | GUC 设空串 | 0 行 |
| 4 | 事务回滚后复用连接（脏 GUC 残留） | 下一事务查不到上一租户数据 |
| 5 | 连接池复用：A 事务后 B 事务同一连接 | 各见各的，无串台 |
| 6 | worker 漏注入 GUC | 0 行 |
| 7 | WITH CHECK：A 上下文 INSERT/UPDATE 出 org_id=B 或 store_id=A2 的行 | 被策略拒绝 |
| 8 | 组合外键：garments 试挂 B 店 order / 同店另一 order 的 order_line | 被约束拒绝 |
| 9 | 压测：10 万 orders / 30 万 garments，5 条代表查询（按票号查单、按条码查件、当日单列表、按客户查历史、月聚合），复合索引命中 | 单店上下文 **P95 < 50ms** |
| 10 | 对照组：同查询关 RLS 跑一遍 | RLS 开销记录在案（数值即可，不设阈值） |

## 证据格式（写入 findings §M0-1）

用例结果表（用例|预期|实际|结论）+ 5 条查询的 P95/P99 表 + 关键 EXPLAIN 摘要 + spike README（一键复现步骤）。

## 不通过的处理

任何一条不达 → findings 里标"不通过"并写根因假设，@Claude 评审；涉及设计修改（如策略模板不可行）→ Claude 起草新增 ADR，不擅自绕过。
