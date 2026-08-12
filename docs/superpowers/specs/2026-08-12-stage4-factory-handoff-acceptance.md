# 阶段 4.3 店厂交接、清点差异与质检返工验收记录

> 日期：2026-08-12
> 状态：**本地 software-only 实现、真实 PostgreSQL/Browser 与全仓门禁已完成；尚未发布**
> 决策：[ADR-45](../../adr/2026-08-12-adr-45-factory-handoff-and-qc.md)（Proposed，待 manpengan 签署）
> 基线：未提交 Stage 3.2–4.2 工作树；`main=origin/main=1c25dfd4423bb9033673e47bc058158086929407`

## 1. 范围

本记录覆盖单一认证门店内部员工使用的交接批次、门店出库、工厂收件、工厂出库、门店收件、完整
扫码差异、R4 异常隔离、工厂收件后的 QC pass/rework、复检和 garment lifecycle 联动。

不包含独立工厂账号、跨组织/跨店工厂联邦、原生移动 App、离线/Edge 扫码、照片、签名、GPS、
司机/路线、真实扫描设备、AI、自动派单或 hk-vps 发布。

## 2. 关闭矩阵

| 层级               | 关闭目标                                                          | 当前状态                    |
| ------------------ | ----------------------------------------------------------------- | --------------------------- |
| ADR/Contracts      | 5 commands + 2 queries、58/38、权限/R3→R4、online-only、非 AI     | 已冻结，ADR 待产品签署      |
| Domain             | 四节点推进、custody 独立、差异集合纯函数                          | 已实现并通过全量门禁        |
| Schema/RLS         | 0053 批次/manifest/attempt/checkpoint/discrepancy/QC、anchor、RLS | 已实现并通过真实 PostgreSQL |
| Server             | memory/PG、幂等/版本、差异阻断/R4、QC/返工、WYSIWYS               | 已实现并通过全量门禁        |
| Web                | 建批、完整扫描、红色差异、R4 处置、QC/复检、窄屏                  | 已实现并通过真实 Browser    |
| PostgreSQL         | apply/replay、RLS/GUC、append-only、锁序、跨租户与故障注入        | fresh PostgreSQL 门禁已通过 |
| Browser/Cloud      | 四节点 + mismatch + QC/rework 合成旅程                            | fresh Browser 4/4 已通过    |
| Workspace/Security | format/lint/typecheck/test/build、独立安全与数据库复核、精确清理  | 全仓门禁与独立复核已通过    |
| External/mobile    | 外部工厂身份、实机扫码、照片/GPS、offline                         | 明确后置，未宣称已交付      |

## 3. 已冻结的不可替代证据

- garment `status` 不证明保管责任；必须同时读取独立批次/checkpoint/custody evidence。
- 批次存在不等于已出库；只有 `store_dispatch` exact checkpoint 才证明门店交出本批匹配衣物。
- 扫描数量相同不等于集合相同；必须证明 missing 和 unexpected 都为空。
- 浏览器红色清单不等于数据库阻断；普通 mismatch 后真实批次/version/custody 必须保持不变。
- R4 点击成功不等于异常件已找回或已丢失；只证明该 attempt 已被另一管理员按受控原因处置。
- QC pass 不等于批次已出厂；所有 active member 最新 QC 为 pass 且 garment ready 后，仍要独立
  `factory_dispatch` exact checkpoint。
- software Browser/PG 验收不等于外部工厂账号、手机 App、真实扫码枪、照片签名或 GPS 已交付。

## 4. 必测行为矩阵

### 4.1 Contracts 与确认

- 严格拒绝未知字段、重复 garment/barcode、控制字符、越界数组和客户端自报租户/状态/摘要。
- mutation 缺少服务端认证 device UUID 时失败且不留业务/审计行；query 仍可按权限读取。
- create/checkpoint 51–100 件从 R3 升到 R4，100 以上拒绝；QC 最大 50；resolve 允许
  unexpected-only 的空 missing garment ids。
- `factory_handoff` 摘要的票号/条码排序、counts 和 digest 内部一致，不出现客户姓名/手机号。
- 既有 bulk/rework/incident/lost 生成 `fulfillment_operation` 摘要，二跳只提交 `confirm_ref`；
  authority 漂移、错 command、错 actor/session 或旧版本失败关闭。
- 两条新查询及五条新命令不进入 `M2_READ_ONLY_AI_DEFINITIONS`，offline 均为 denied。

### 4.2 数据库与 Server

- create 只接受 `received | reworked`、open order、store custody、无 active batch；混入一件不合格
  整批回滚且没有孤立 audit/evidence。
- 四节点严格按序；跳步、重复、cancel 非 packing、旧 version、跨店/跨组织 UUID 都返回安全错误。
- exact scan 一次推进；missing/unexpected 只追加 attempt，不改变 batch/member/custody。
- resolve 只能引用 latest discrepant attempt；missing 集合必须精确，unexpected-only 必须空数组；
  unexpected 不入 manifest，missing 转 exception 而非 lost，匹配成员推进。
- QC 仅在 factory_received；pass→ready，rework→reworked，可复检；未全 pass/ready 禁止 factory_dispatch。
- 同一 idempotency key 在 COMMIT 后响应丢失、并发重送时不重复追加任何 evidence/audit。
- 所有新表 FORCE RLS；app role 缺 GUC/只设 org/伪造 store 均不可读写；owner/maintenance 旁路受既有
  独立门禁约束。
- 并发用 `order → garment → batch → child` 稳定锁序，不能靠 deadlock retry 取得绿色结果。
- 五条写命令和两条 PII-adjacent 查询分别经过 session + org + store 限流；达到边界后在任何领域
  查询或 evidence 写入前返回 `429` 与 `Retry-After`，其他门店/会话及写读桶互不占用。

### 4.3 Web 与 Cloud

- 列表只展示当前门店 eligible garment 和近期批次，不出现顾客姓名/手机号。
- 建批确认展示服务端 factory code、票号/条码、件数和 digest；浏览器不计算或回传摘要。
- 四节点都使用完整扫码集合；窄屏可操作并能清空/重扫，提交中禁重复点击。
- mismatch 明确分开展示 missing/unexpected，红色阻断；普通员工不能看到可执行的 R4 绕过入口。
- R4 处置要求另一 active admin，当 authority/version 漂移时刷新而不是静默成功。
- QC 表单每件只允许 pass 或受控 rework reason；返工后可复检，未全合格不显示为可出厂。
- 页面刷新/重新登录从查询重建权威状态，不依赖 React 内存假状态。

## 5. 新鲜证据记录

以下结果均来自同一最终本地工作树，不把软件模拟证据外推为真实工厂、硬件或生产发布：

- Contracts 59 files / 794 tests、Domain 19 files / 185 tests、DB 81 tests、Web 399 tests 全绿；
  Server 996 tests 中 906 通过、90 个真实环境 opt-in 明确跳过。
- `pnpm local:commissioning:fresh:pg` 在全新 PostgreSQL 16 上完整应用 53 个迁移并复核 0053 replay；
  ADR-45 专项 5/5 通过，覆盖 app role/RLS/GUC、四节点、差异/R4、QC 复检、隐私与锁序。
- 最终 0053 `database_restored_catalog` 为 `entries=1238`、
  `sha256=b175abcb3e4a45872bc497b65c4b84232c8e9d0a4e2df0b5f0cf252e6e870df8`；
  该值是 PostgreSQL catalog 证明，不是 migration 源文件摘要。
- `pnpm local:commissioning:fresh:browser` 的 commissioning 1/1 与产品旅程 4/4 全绿；店厂旅程覆盖
  390px 窄屏、R4 差异处置、QC/复检、四节点推进、异常计数可见和顾客 PII 负向断言。
- `pnpm workspace:check` exit 0：依赖 high/critical 为 0，format/lint/typecheck 全绿，foundation
  278/278、Edge 56/56、Cloud 275 通过/1 个平台 opt-in 跳过，9/9 production build 成功。
- 独立安全复核未留下 P0/P1/P2；最终 TS/JS 独立复核 P0/P1/P2 为 0，workspace typecheck 12/12、
  lint 9/9 与 `git diff --check` 全绿。数据库独立复核以同一最终 migration 和真实 PG 为准。
- 最终数据库独立复核结论为可提交，P0/P1 为 0；保留 3 个不阻塞本切片的软件债：无状态筛选的
  批次列表可补专用排序索引、8 个 staff 审计外键可补前导 child index，以及已手工通过的
  terminal exception 后 `mark_lost` 路径应固化成仓库回归。这些项不改变当前正确性判定，后续
  数据增长或继续触及 0053 时必须优先关闭。
- fresh PostgreSQL 与 Browser 验收均报告精确 commissioning container/network/volume 已清理；
  历史随机测试临时目录不属于本次精确项目，未获删除授权且未读取内容。
- 本地分批 commit 与 GitHub `main` push 由本次收尾执行；required CI 与 hk-vps release 仍是独立证据，
  本记录不宣称它们已经完成。

## 6. 完成判定

只有关闭矩阵所有本地软件项取得同一最终工作树的新鲜证据，并完成精确资源清理，才能把本记录改为
“本地实现完成”。只有 clean pushed exact `main`、required CI、远端迁移/catalog、发布 transition、
公网 API/Browser 和回滚证据全部通过，才可声称 hk-vps 已发布。外部工厂、移动实机或硬件扫码仍需
各自独立 ADR 与真实证据，不随 Stage 4.3 软件完成自动转正。
