# M0-1 验收单：RLS 三元租户隔离 + 性能

> 主责：**Codex**　验收：Claude　产出：`tools/spikes/m0-1-rls/`
> 依据：ADR-02（全条款）、架构 §4/§7 租户列规则、实施计划 §1.1、任务书 codex §2
> 公共规则见 [README](README.md)（不写生产代码、虚构数据、证据落点）。

## 1. 目标

把 ADR-02 的两个设计假设变成实测证据：**(a)** 数据库层 RLS 兜底在五类旁路场景下全部 fail-closed；**(b)** FORCE RLS + 三元组合键在 10 万单压力下常用查询 P95 < 50ms。任何一条不成立都动摇 M1 的 RLS 强制上线决策，必须在写生产代码前发现。

## 2. 步骤

1. PG 16（建议直接复用 M0-6 compose 的库，角色口径一致）；建表所有者 owner 角色与应用角色 `laundry_app`（**非所有者、NOBYPASSRLS**）。
2. 建最小三表并全部 `ENABLE` + `FORCE ROW LEVEL SECURITY`：
   - `orders` — `UNIQUE(org_id, store_id, id)`；
   - `order_lines` — `UNIQUE(org_id, store_id, order_id, id)` + `FK(org_id, store_id, order_id) → orders(org_id, store_id, id)`；
   - `garments` — 双组合外键：`FK(org_id, store_id, order_id) → orders` **及** `FK(org_id, store_id, order_id, order_line_id) → order_lines(org_id, store_id, order_id, id)`（含 `order_id`，防同店跨单挂行）。
3. 写两种策略模板（org 级 / 店级），**各含 USING 与 WITH CHECK 两半**；条件只做本行字段与 GUC 的简单比较（`current_setting('app.org_id', true)` 形态），禁跨表子查询。
4. 以 `laundry_app` 连接跑五类旁路负向用例（读写两侧）：GUC 未设置 / GUC 空值 / 事务回滚后残留 / 连接池复用串租户 / 模拟 worker 漏注入。
5. 造数 ≥2 org × ≥2 store、10 万 orders（含行/件），建 `(org_id, store_id, …)` 复合索引；选三条代表查询（单店当日单列表、按状态过滤、按客户查单）测 P95；同结构关 RLS 对照测开销。
6. 产出 README（一键复现）+ findings `## M0-1` 小节。

## 3. 通过标准（逐条判定）

- [ ] 五类旁路**读侧全部 0 行**：查询正常返回空集，而非报错——报错可能被上层捕获后放行，fail-closed 语义必须是"查不到"。
- [ ] **写侧被 WITH CHECK 拒绝**：GUC 未设置、或 INSERT/UPDATE 伪造他租户 `org_id/store_id` 时，写入报 RLS 违例，无一落库。
- [ ] 连接池复用与回滚残留场景：前一事务的租户上下文**不泄漏**到后一事务（`SET LOCAL` 语义实证）。
- [ ] 组合外键拒绝跨挂：garment 引用同 org 异 store、或同店异单的 order_line，均被外键拒绝。
- [ ] 10 万单下三条代表查询 **P95 < 50ms**（`laundry_app` + FORCE RLS + 复合索引；EXPLAIN 命中索引、无 Seq Scan）。
- [ ] RLS on/off 开销对照数据已记录（同查询 P95 差值；不设阈值，供设计参考）。
- [ ] 业务查询全程 `laundry_app` 执行；owner 仅用于建表。

## 4. 证据格式

- `tools/spikes/m0-1-rls/README.md`：环境（PG 版本、宿主硬件）、一键复现脚本入口、结果摘要。
- `evidence/`：五类旁路逐用例输出（SQL + 返回行数/报错原文）、压测原始数据（P50/P95/P99 表）、`EXPLAIN (ANALYZE, BUFFERS)` 文本。
- DDL 与策略模板独立 `.sql` 文件——此文件即 M1 A3（租户矩阵 + 策略模板进 contracts）的实测底稿。
- findings `## M0-1` 小节：按模板填结论行、通过标准逐条对照、关键数据、偏差与坑。

## 5. 不通过 / 需改设计

任一旁路查到跨租户行 = **一票否决**（不通过）。P95 不达标先试索引/查询改写；仍不达标报「需改设计」，由 Claude 起草 ADR（如 security_barrier 视图/预聚合，禁 BYPASSRLS 绕过——ADR-02 后果条款）。
