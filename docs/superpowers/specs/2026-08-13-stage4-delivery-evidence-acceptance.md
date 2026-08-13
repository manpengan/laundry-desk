# 阶段 4.4 Item 6 取送现场交付证据验收记录

> 日期：2026-08-13
> 状态：**隔离工作树候选；本地 focused/真实 PostgreSQL 门禁通过，未合入或发布**
> 决策：[ADR-51](../../adr/2026-08-13-adr-51-delivery-evidence.md)（Proposed，待 manpengan 签署）
> 前置提交：Item 5 `3791cb778c11177801ade12de15fefeac6c7bfcb`

## 1. 范围与推翻关系

本 Item 覆盖当前 accepted 任务受派人的 pickup、delivered、exception 证据，服务端接收的照片/签名附件、
单次 GPS 定点、原子完成配送腿、专用私有上传/下载、移动 H5 采集/确认/列表以及隐私计数/裁决。它推翻
Item 5 的“无交付证据”和“客户端直接完成订单腿”边界；接单/拒绝与开始取件/开始送回仍复用 Item 5。

不包含路线导航、持续/后台定位、顾客公开自助、原生 App、第三方配送 provider、自由地址/电话/路线
文字或媒体内容导出。真实手机 Browser、required CI、合入与 hk-vps 发布不由本地候选预先宣称。

## 2. 关闭矩阵

| 层级              | Item 6 目标                                      | 候选证据                   |
| ----------------- | ------------------------------------------------ | -------------------------- |
| Contracts/OpenAPI | 1 写 1 读、strict、69/48、非 AI                  | focused + snapshot         |
| Domain/DB         | pickup/return 必需证据、append-only、0058        | focused + real PG          |
| Server            | memory/PG、原子完成、R3、无敏感 audit/event      | focused/type/build         |
| Media             | 私有字节、失败清理/replay、下载重授权、限流/CSRF | route/file focused         |
| Mobile H5         | 明确 GPS/文件动作、完整确认、旧响应/断网失效     | model/surface focused      |
| Privacy           | 只导出计数与保留/清理裁决                        | parser + migration focused |
| External          | Browser、CI、合入、发布                          | 未执行，不宣称交付         |

## 3. 权威与安全判定

- `delivery.evidence.record` 的 `complete_leg` 是完成 pickup/return 的唯一移动入口；订单、任务和证据同事务，
  不能先完成再补证据。pickup 要 GPS + photo，return 还要 signature；exception 只能 record-only。
- 上传、事件、链接分别固定 org/store/order/task/leg/task version/assignee，DB actor 与时间来自会话 GUC/
  statement timestamp。应用角色不能 UPDATE/DELETE/TRUNCATE；跨店、换员工、过期附件或 stale CAS 失败。
- 媒体字节只走专用认证路由和私有 durable 子目录；DB/API/audit/event/AI 不返回 storage key、摘要、坐标
  或媒体内容。下载每次重新证明 tenant/store/task/assignee，响应 no-store。
- H5 定位和文件只由点击触发；scope、选择、版本、离线和 AbortSignal 令旧请求与确认失效，不排队写。
- 隐私导出只含证据/附件计数及明确保留、过期孤儿文件清理裁决；匿名化不泄露或复制现场内容。

## 4. 新鲜证据

- focused：Contracts/OpenAPI `13/13`、Domain `2/2`、DB `71/71`、Server memory `2/2`、Web mobile
  `18/18` 均通过。
- 真实 PostgreSQL：独立 `8558` 从空库记录 `58 formal migrations`，Item 6 invariant `1/1` 通过；账本为
  `0058_delivery_evidence.sql`，随后输出 `ADR51_REAL_PG_CLEANUP_OK` 并精确清理隔离 network/volume/config。
- 最终静态门禁：Contracts/Domain/DB/Server/Web 的 typecheck/build `11/11`，相关 lint、format、确定性
  OpenAPI、SPA `sync/check`、`git diff --check` 均通过。
- 规模/秘密：变更生产 JS/TS 最大 `400` physical lines、测试最大 `788`，静态秘密模式扫描无命中。
  exact commit 由交接记录绑定；本候选没有执行 push、Browser、required CI、合入或发布。

## 5. 完成判定

只有最终 diff 仍保持一个权威写、一个读、0058/ADR-51、生产 TS/TSX 不超过 400 行、测试不超过 800
行，并且 focused、真实 PG、OpenAPI、lint/type/build、SPA、diff/size/secret 属于同一 clean commit，才可
交给父任务集成。本记录不替代 Browser、required CI、合入或 hk-vps exact-SHA 发布。
