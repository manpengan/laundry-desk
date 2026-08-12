# 阶段 3.4 顾客扩展档案与政策验收记录

> 日期：2026-08-12
> 状态：**本地候选实现、真实 PostgreSQL/Browser、总门禁与独立安全复核已完成；尚未形成 PR、主线 CI 或 hk-vps 发布证据**
> 决策：[ADR-42](../../adr/2026-08-12-adr-42-customer-extended-profiles-and-discount-policy.md)
> 基线：Stage 3.2/3.3 未提交本地候选；`main=origin/main=1c25dfd4423bb9033673e47bc058158086929407`

## 1. 范围

本记录覆盖组织级多地址、车辆/标签/外部标识、联系与服务偏好、三类运营豁免、顾客覆盖折扣、
会员等级折扣及订单/打印/上挂快照。0051 同时关闭既有多跳 merge、通用 PII 副本与匿名化后离线
复活三组 P1；法律电子签署、地图/配送、复杂营销与阶段 4 不在本片。

## 2. 证据矩阵

| 层级       | 目标                                                               | 当前状态                   |
| ---------- | ------------------------------------------------------------------ | -------------------------- |
| Contracts  | 2 commands / 1 query、显式 RBAC、52/33 freeze、AI/offline 不扩面   | 完成；780/780              |
| PostgreSQL | 0051/5 表、递归组、HMAC 墓碑、全副本 purge、CAS/RLS、apply/replay  | 完成；组合回归 31/31       |
| Server     | profile/discount 双后端、离线终态、自动计价、券互斥、打印/上挂豁免 | 完成；833 pass/82 PG skip  |
| Web        | 顾客扩展档案、R4 折扣、等级折扣、开单结果与豁免状态                | 完成；387/387              |
| Browser    | 合成地址/车牌保存检索、等级/顾客折扣、订单快照与拒绝路径           | 完成；commissioning 1/1、功能 2/2 |
| Cloud      | ADR-42 合成 API journey 与既有发布/浏览器边界回归                  | 完成；本地工具 199/199     |
| Workspace  | audit/format/lint/typecheck/test/build、SPA drift                  | 完成；exit 0               |
| Security   | P1 基线修复、PII/RLS/merge/anonymize、离线复活、折扣与快照独立复核 | 完成；P0/P1/P2 = 0         |
| GitHub     | PR、required checks、精确 merge SHA 主线 CI                        | 未授权/未执行              |
| hk-vps     | 两阶段发布、marker/0051/API/Cloud Chromium/隐私与清理              | 未授权/未执行              |

## 3. 本地候选证据（2026-08-12）

- 全新隔离 PostgreSQL 从空卷完成 51 个迁移的 apply/replay、commissioning、ADR-41 3/3 与
  顾客/会员/pending 组合回归 31/31；release catalog 同时验证 0050、0051 golden head 与 write
  gate，最终摘要为 `6fd33bd261bde7a304279485364de59a7dbf8140f994a5b9263d5e7ee604b587`。
- fresh-browser 在同一真实 PostgreSQL 路径完成 commissioning 1/1，以及会员权益和顾客档案
  Chromium 2/2。顾客旅程覆盖地址/标识、等级与顾客折扣优先级、订单冻结快照、打印/上挂豁免，
  并证明浏览器请求不提交租户权威或计算后金额。
- Web 387/387、Cloud 199/199、Edge 460/460；Edge SPA 已按内容寻址流程同步到
  `bd050a96c88dc8bb2883655f3c6de4cae60dcf1190f2f28014ba6b8548f9b557`，`spa:check` 通过。
- `pnpm workspace:check` exit 0：dependency audit high/critical 0、format、lint 9/9、typecheck
  12/12、Foundation 278/278、Contracts 780/780、DB 73/73、Server 833 pass/82 opt-in PG skip、
  Web 387/387、Cloud 199/199、build 9/9；最终 `git diff --check` 与独立 SPA drift check 同样通过。
- 独立安全终审覆盖递归 canonical group、历史手机号 HMAC 墓碑、匿名化锁序与全副本清理、
  pending/idempotency/replay/audit、Edge 终态、计价/豁免、RLS/GUC 和照片保留例外，结论为
  P0/P1/P2 全 0。精确验收 project、5173/8543/8787 监听及 Playwright/Chromium 进程均为 0；
  历史随机测试临时目录无法仅凭名称映射到本轮项目，未经清理授权保持原状且未读取其内容。
- 当前证据只证明本地候选。PR、required CI、精确 merge SHA 与 hk-vps 两阶段发布仍未获授权，
  公网数据库迁移和 Cloud Chromium 不能由本地旅程代替。

## 4. 不可替代的关闭条件

- Web 表单测试不能替代真实 PostgreSQL 的跨组织 RLS、CAS、合并源和匿名化证据。
- 服务端单测不能替代 Browser 证明请求中没有 org/store、自动折扣基点或计算后金额。
- 新表/列存在不能替代订单历史快照、打印/上挂豁免与报表金额不重估。
- 清空 `customers` 不能替代 audit/idempotency/pending/replay/profile children 的同事务 purge；
  HMAC tombstone 必须证明旧 Edge 队列终态 ack 且不会重建顾客或订单。
- 单门店直接 merge 不能替代 A→B→C 与另一门店 source 订单的递归 export/anonymize 证据。
- 本地实现完成后可按用户授权进入阶段 4；PR/CI/hk-vps 仍独立 pending，不得标成已发布。
