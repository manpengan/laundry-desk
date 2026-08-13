# 阶段 4.4 Item 5 配送员/员工移动 H5 验收记录

> 日期：2026-08-13
> 状态：**历史验收记录；交付证据边界与直接完成行为已被 ADR-51 / Item 6 推翻**
> 决策：[ADR-50](../../adr/2026-08-13-adr-50-mobile-delivery-task-h5.md)（Proposed，待 manpengan 签署）
> 前置提交：Item 4 `58bb10eb3f8fc9a4630ed50a0053c0eb87ffc545`
> 实现基线：Item 5 exact commit `3791cb778c11177801ade12de15fefeac6c7bfcb`

## 0. Item 6 推翻说明

本记录只证明上列 Item 5 exact commit 的历史边界，不再代表当前候选产品面。ADR-51 / Item 6 同批新增
69/48 契约、`0058`、专用私有交付附件和移动 H5 证据采集，并推翻以下旧结论：

- accepted 任务不再可由客户端分两次“先完成订单腿、后补现场证据”；`pickup_in_progress -> picked_up`
  与 `return_in_progress -> completed` 只通过 `delivery.evidence.record` 的受控 `complete_leg` 原子完成。
- Item 5 的“无 GPS/照片/签名/证据字段”“Contracts/Server/DB 无 diff”和冻结 68/47 只属于历史
  commit；当前 Item 6 是 69/48 与迁移头 `0058`。
- 原有接单、拒绝和“开始取件/开始送回”仍有效；任务、会话、generation/AbortSignal、断网只读与完整
  authority 原则继续成立。路线导航、后台定位、顾客公开自助和第三方配送 provider 仍未交付。

Item 6 当前候选验收以
[阶段 4.4 Item 6 验收记录](2026-08-13-stage4-delivery-evidence-acceptance.md)为准；本文件后续章节保留为
不可改写的历史测试证据。

## 1. 范围

本记录只覆盖 Cloud Web 手机浏览器的精确 `/mobile/tasks` 当前员工任务面：安全登录或既有 cookie 会话
恢复、我的任务列表/详情、接受/拒绝、accepted 任务对应的既有订单腿推进、刷新、明确错误和断网只读
降级。管理员使用该入口时也没有分派、转派或人工接管；这些继续由 ADR-49 桌面员工面承担。

本 Item **没有**新增 Contracts、Server handler、数据库表或迁移，冻结面保持 68/47；没有改动
`packages/contracts`、`apps/server` 或 `packages/db`。不包含 Item 6 的路线导航、GPS、照片、签名、扫码、
后台定位或其他交付证据，也不包含顾客公开自助、离线写队列、原生 App 或第三方配送 provider。

## 2. 关闭矩阵

| 层级             | Item 5 目标                                                     | 候选状态                         |
| ---------------- | --------------------------------------------------------------- | -------------------------------- |
| Route/Host       | 精确 `/mobile/tasks`、browser-only、Counter/Owner resume 隔离   | focused 与 production build 通过 |
| Auth/Privacy     | refresh cookie 恢复、token 私有、logout/scope 清理、旧 PII 隔离 | deferred/冷恢复回归通过          |
| Existing API     | 两读任务 + 一读订单 + 接拒/订单转换，不扩 68/47                 | strict Zod 与统一信封回归通过    |
| WYSIWYS          | typed task summary；完整 client-frozen order authority          | 详情/选择/scope 失效回归通过     |
| Mobile UI        | 我的任务、窄屏、断网、错误、feature-off、可访问性               | SSR/CSS 与 Web 全量测试通过      |
| Item 6 boundary  | 无 GPS/照片/签名/路线/证据字段                                  | parser/UI 静态回归通过           |
| External/release | Browser、required CI、合入与 hk-vps exact-SHA 发布              | 未执行，不宣称交付               |

## 3. 路由、权限与 feature-off

- `/mobile/tasks` 和 `/mobile/tasks/` 才选择 `mobile_delivery_tasks`；`/mobile`、子路径、大小写变体回到
  Counter surface。Electron 保持 Counter，移动入口不经过 Owner LAN gateway。
- 只有 browser mobile surface 会在冷启动调用 refresh-cookie resume；browser Counter 与 `/owner` 不会
  静默恢复，desktop 原恢复保持启用。
- 列表输入固定为会话 `staff_id`；列表混入其他 assignee、详情 task/order ID 不一致或 strict schema 多出
  字段时整次失败关闭。客户端不接收 org/store/customer 作为选择 authority。
- UI 只呈现当前员工接拒和订单腿执行；没有 `delivery.task.assign/transfer/takeover` 调用或控件。最终权限
  仍由 Server RBAC、当前门店、assignee 重验和 RLS 强制。
- `delivery_enabled=false` 显示“新入口关闭、既有任务仍可收口”，不会错误禁用既有任务的接拒或执行。

## 4. 状态与确认行为

- offered 任务可以接受，或选择受控 reason 后拒绝；首跳必须返回严格
  `delivery_task_operation/respond` summary，并逐字段匹配当前 task/order、assignee、决定和两侧版本。
- accepted pickup 任务只允许 `pickup_scheduled -> pickup_in_progress -> picked_up`；accepted return 任务只
  允许 `return_scheduled -> return_in_progress -> completed`。其他订单状态不显示执行按钮。
- order transition 首跳 body 由严格详情构建。收到 R3 `confirm_ref` 后，客户端冻结完整 task/order/
  laundry ID、腿、任务状态、任务/订单版本、路线、当前→目标状态和可选取消原因；确认卡显示完整 ID，
  不用短 ID 代替 authority。二跳前从当前详情重建全部字段并比较同一 authority key。
- 任务选择、active/all 筛选、详情/版本/路线变化、网络断开、logout 或 session/store/staff/permission scope
  变化都会撤销 pending；旧 `confirm_ref` 和 deferred response 不能回填或续跑。
- 二跳只提交 `confirm_ref`。写 transport 被 abort 时返回 `REQUEST_ABORTED`，不会映射为 NETWORK 或自动
  重放；操作员刷新并显式重试时复用原幂等键，避免响应未知时生成不同写身份。

## 5. 断网、错误与移动可访问性

- 网络断开立即 abort 三类 channel、关闭确认并停用刷新/接拒/转换；同一 session 最后成功列表和详情
  可继续只读核对，不写 Web Storage 或离线队列。恢复网络自动重读权威列表。
- 权限拒绝、网络失败、CAS/幂等冲突、认证过期、Zod 解析失败和未知响应分别给出可操作提示；认证过期
  先清状态再回登录。
- 720px 下列表/详情切换，390px 下事实和确认卡单列；safe-area、跳主内容、语义 status/alert、可见
  focus、文字状态、44/48px 目标和 reduced-motion 均有静态回归。
- UI 不显示 customer ID、顾客姓名/电话/地址；strict task parser 明确拒绝 GPS/照片/签名等 Item 6 字段。

## 6. 新鲜证据

以下结果来自基于 Item 4 exact commit `58bb10eb3f8fc9a4630ed50a0053c0eb87ffc545` 的同一隔离工作树：

- `pnpm --filter @laundry/web typecheck` 通过。
- `pnpm --filter @laundry/web lint` 通过，零 warning；`pnpm --filter @laundry/web build` 通过（450 modules）。
  大 chunk 只有既有 Vite 非阻塞 warning，没有构建失败。
- 6 个 Item 5 focused 文件共 20/20 通过；`pnpm --filter @laundry/web test` 完成 production Vite build，
  Web 全量 448/448 通过。focused 回归覆盖精确路由/resume gate、cold refresh token 私有性、logout 与
  deferred refresh、HTTP
  abort、幂等键、strict my-task/detail parsing、四条执行边、完整 WYSIWYS 卡、selection/detail/scope
  失效、窄屏与 Item 6 排除。
- `pnpm --filter @laundry/edge-agent spa:sync` 与随后 `spa:check` 均通过（`entries=3`）；最终活动 bundle
  是 `c6713fa9f4c4a499cbf0120f2b7cb04bd66f4ae5a52eb95a249fa0427651c848`，中间候选 bundle 已移除。
- 新增 Item 5 生产 TS/TSX 最大文件是 `mobile-task-model.ts` 360 行，其次是
  `use-mobile-task-mutations.ts` 347 行；触及的 `query-client.ts` 为 399 行，新增测试最大 354 行，均在
  400/800 门禁内。`HttpAuthClient.ts` 从 Item 4 基线既有 461 行变为 463 行，仅承载 cold-resume
  generation 比较；这是已存在的超默认规模文件，不把它错误记作 Item 5 新增超限。
- Contracts/Server/DB 无 diff；没有 migration，`m2-freeze.test.ts` 未修改，冻结面仍为 68/47。
- 按本批产品裁决，以同一稳定候选的 fresh focused/full、lint/type/build、SPA 与规模证据交付父任务；
  独立 security review 轮次未执行，也不把它记作通过。

这些是本地候选证据，不替代真实手机 Browser、required CI、合入或 hk-vps exact-SHA 发布。

## 7. 完成判定

Item 5 候选只有在最终 diff 仍无迁移/新契约/Item 6 字段，新增生产 JS/TS 与测试文件不超过 400/800，
且 Web focused/full test、lint/type/build、SPA sync/check 全部属于同一最终工作树时，才能交给父任务
集成。若后续重新要求独立安全审查，须绑定同一候选 diff。Browser、required CI、合入和 hk-vps 发布
必须后续绑定最终 exact SHA，不能由本记录预先宣称。既有 `HttpAuthClient.ts` 超默认规模须作为显式
遗留继续跟踪，不以 Item 5 候选伪装关闭。
