# ADR-37 阶段 2 柜台可信性验收记录

> 日期：2026-08-11
> 当前状态：**PASS — 精确 merge SHA 已完成 CI、0047 两阶段发布与云端审计；阶段 2 已关闭**
> 决策：[ADR-38](../../adr/2026-08-11-adr-38-cloud-counter-trust-closure.md)
> 执行计划：[Cloud Web-first 1–4 交付计划](../plans/2026-08-10-post-adr36-delivery-plan.md)
> 云环境边界：[ADR-36](../../adr/2026-08-09-adr-36-cloud-test-environment.md)

## 1. 记录边界

- 本记录把 Contracts/Domain、Server、PostgreSQL、Browser、GitHub CI 与 hk-vps 发布分层；
  任一层绿灯都不代替其他层。
- 候选已通过 [#167](https://github.com/manpengan/laundry-desk/pull/167) 合入 `main`；本记录同时
  保留本地、PR、merge-SHA 主干 CI、hk-vps 发布和发布后独立审计证据，不用任一层代替另一层。
- 浏览器与云环境只使用合成数据；不记录密码、PIN、token、cookie、私钥或真实顾客 PII。
- Browser 硬刷新会清空 renderer 内存会话；验收明确重新登录后从服务端恢复挂单，不以
  localStorage 或 React 内存冒充持久真源。

## 2. 三个顺序 checkpoint

| 切片                   | 实现结果                                                                                                                       | 新鲜本地证据                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 2.1 计价与设置权威     | `pricing.policy.get/set`、店级版本化策略、服务端 catalog/add-on/固定费定价、admin-only 折扣、R5 双管理员设置 UI、0047 扩展迁移 | Contracts、DB、Server、Web 全绿；独立 PG 16 的 47 条迁移双跑与完整 Server 真库套件；Browser 柜台纵向通过              |
| 2.2 支付流水与退款 Web | `payment.ledger.list` 有界投影、服务端剩余可退金额、订单详情原流水选择、既有 R4 另一管理员复核、确认续跑只发 `confirm_ref`     | Domain 181/181；Server 4/4；Web 27/27；真实 PG 5/5；Browser 1/1，覆盖 ¥10 收款、¥2 退款、剩余可退 ¥8、欠款 ¥32 与结清 |
| 2.3 件级明细与挂单恢复 | 每件颜色/品牌/瑕疵/附件/备注/add-on；完整 `order.get`；有界 draft 列表；硬刷新后重新登录并恢复同一 `draft_id`                  | Contracts 762/762；Web 367/367；Server 订单详情/计价 8/8；PG workday 1/1；Browser 柜台纵向通过                        |

2.3 的独立 PostgreSQL 16 环境从空卷应用 47 条迁移并重复 reconcile；真实 `order.get` 同时
回读 draft 的 JSONB 件级快照和正式 garments 属性。浏览器纵向依次完成逐件差异录入、暂存、
硬刷新、重新登录、服务端恢复、权威开单、R4 双人退款和取衣结清。相关临时容器、卷与
`/private/tmp` 私有配置均在运行后核验为零残留。

最终候选再次从隔离空卷应用 47 条迁移并重复 reconcile，完整真实 PostgreSQL Server 为
848/848、0 failed、0 skipped；完整 Chromium 为 17/17。全仓最终计数为 Contracts 762/762、
Domain 181/181、Web 367/367；生成后的 SPA manifest/bundle 校验通过。

## 3. 最终关闭门禁

| 门禁                | 当前状态   | 关闭条件                                                                                              |
| ------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| 全仓质量            | **已通过** | `pnpm workspace:check`：依赖审计、格式、lint、typecheck、测试、构建全部通过                           |
| 完整真实 PostgreSQL | **已通过** | 47 条迁移双跑；Server 848/848、0 skipped；Chromium 17/17；commissioning、catalog 与环境清理通过       |
| GitHub PR           | **已通过** | PR #167 head `871657a…4866` 三项 required checks 全绿并合入                                           |
| 合并后主干          | **已通过** | merge SHA `6f106076…3f47` 的 Foundation #31474079611 与 PostgreSQL #31474079588 成功                  |
| hk-vps 两阶段发布   | **已通过** | 精确 merge SHA、migration head 0047、恢复点、shadow/catalog、API 与 Cloud Chromium evidence committed |
| 发布后审计          | **已通过** | marker/runtime/schema 一致；Desk/PG/Caddy/KB 健康；loopback 边界、权威 evidence 与本地清理通过        |

## 4. 云端关闭证据

- 发布候选：`6f106076018940eec8fcc9e8c2cfb7842c323f47`；旧 marker：
  `7989206b3e9748b2a607687466ef2e0775ad528e`；发布后 marker 与候选一致。
- PostgreSQL 从 46/head 0046 迁移到 47/head `0047_cloud_counter_trust.sql`；compatibility
  为 ADR-38，旧代码兼容；transition 最终回到 `phase=stable`。
- 权威 API evidence `ADR36-20260811T090948556Z-7c27943e` 为 15/15 PASS；Cloud Chromium
  `CLOUD-BROWSER-20260811T091023299Z-ba8276ad` 为 PASS、1 test、0 retry。
- `laundry-desk`、`postgresql`、`caddy`、`kb-web` 均 active，failed units 0；Desk/PG 保持
  loopback，公网 Desk SPA 与 KB health 均为 200；本机 release 临时目录为 0。
- 完整发布身份、保留槽位归档与独立审计见[阶段 2 发布结果](../../operations/2026-08-11-stage2-release-result.md)。

## 5. 已知边界

- 0047 是相对 0046 的纯扩展迁移；代码回滚允许保留 0047，但不得自动降级数据库。
- 独立 PostgreSQL 16 迁移链生成的 0047 golden catalog 为 676 entries / `172d1df5…5938`；兼容白名单精确声明 `0046 → 0047`，裁决为 ADR-38。
- `order.get` 返回 add-on 的 code/name/price 只读快照；恢复层只把 code 投影成命令输入，不能
  将读模型原样回灌严格 schema。
- 本阶段不新增人工单价覆盖、draft 删除、自动通知、会员增强、Owner 公网化、生产 SaaS、
  桌面正式发行或实体打印完成声明。
