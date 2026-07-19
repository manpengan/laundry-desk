# ADR-02: PostgreSQL 多租户与 RLS（M1 强制）

- 日期：2026-07-19　状态：**Accepted**（2026-07-19 定点复核通过，批量签署）　父文档：[总 RFC](2026-07-19-v2-productization-and-ai.md)
- 详设：架构 §4

## 决策

1. PostgreSQL 16，单库共享 schema，`org → store → staff/device` 层级，业务表带 `org_id`（多数含 `store_id`）。
2. **RLS 自 V2-M1 上线，不推迟**：所有租户表 `ENABLE ROW LEVEL SECURITY` 且 **`FORCE ROW LEVEL SECURITY`**（表所有者默认绕过 RLS，必须显式强制——PostgreSQL 官方语义）；策略默认拒绝。
3. 应用以**非表所有者角色** `laundry_app`（NOBYPASSRLS）连接；迁移用独立 owner 角色。
4. 租户上下文经会话变量注入：每事务 `SET LOCAL app.org_id / app.store_id / app.staff_id`；连接池按事务注入；**后台任务与队列 worker 走同一注入**，禁止裸连接查询。
5. 服务层租户过滤保留为第一道防线（双保险）。
6. **跨租户负向测试进 CI 门禁**：覆盖 API、队列任务、报表导出三条路径。
7. 性能约束：策略条件必须命中 `(org_id, …)` 复合索引；V2-M0 实测 RLS 开销。
8. **租户数据模型可执行化（三审修正为三元组合）**：业务表直接持有 `org_id`（店级再持 `store_id`）；店级父表 `UNIQUE(org_id, store_id, id)`，子表以**三元组合外键**引用——`garments(org_id, store_id, order_id) REFERENCES orders(org_id, store_id, id)`；`garments → order_lines` 组合键**必须含 order_id**（防衣物挂到同店另一订单的计价行）；order_lines / payments / garment_status_log / print_jobs / ticket_no_blocks 同构。**二元 `(org_id, id)` 只防跨品牌、不防同品牌跨门店，废弃**。三类表矩阵随 contracts 冻结（M1）。
9. 策略模板仅 org 级/店级两种，基于**本行字段与 GUC 的简单比较**；禁止跨表子查询策略（复杂且有并发一致性风险）；**模板同时含 USING（读）与 WITH CHECK（写入约束）两半，M1 一并冻结**（终审补充）。
10. 负向测试扩充五类旁路：GUC 未设置（必须 0 行而非报错放行）/GUC 空值/事务回滚残留/连接池复用串租户/worker 漏注入；租户上下文只来自服务端认证会话注入，浏览器/LLM/Edge 自报一律忽略。

## 理由

仅靠服务层过滤，任何漏写 where、后台任务或原始查询都可能跨租户（二审 P0）；SaaS 租户泄露是存在性风险，必须数据库层兜底。

## 否决的备选

- schema-per-tenant / database-per-tenant：运维与迁移成本对中小店 SaaS 过重。
- RLS 推迟到 v2.1（draft1 方案）：被二审否决，理由成立。

## 后果

- M0 需产出 RLS 性能基线；连接池实现必须支持事务级 GUC。
- 报表类复杂查询如遇 RLS 性能瓶颈，用 security_barrier 视图或预聚合表解决，不得以 BYPASSRLS 绕过。
