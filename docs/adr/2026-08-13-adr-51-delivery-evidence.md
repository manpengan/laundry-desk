# ADR-51：取件、送达、异常与现场交付证据

- 日期：2026-08-13
- 状态：**Proposed（实现候选与本地 focused 门禁收尾中；待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 前置：[ADR-49：权威配送任务](2026-08-13-adr-49-authoritative-delivery-tasks.md)、
  [ADR-50：移动 H5](2026-08-13-adr-50-mobile-delivery-task-h5.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Contracts、Domain、`0058`、Server/私有媒体、移动 H5、隐私导出、OpenAPI

## 背景

ADR-48/49 已分别建立配送路线真源和员工任务保管链，ADR-50 让当前受派人在手机浏览器执行任务。但
Item 5 仍允许把订单腿完成与现场证据分成两次写；响应未知、换员工或补证据失败时，系统可能出现“任务
已完成但无交付证据”。把附件塞进既有 `garment_photos` 也会混淆衣物质检照片与配送现场证据的权限、
保留和隐私语义。

## 决策

### 1. 专用追加式证据与附件元数据

`0058_delivery_evidence.sql` 新增 store-scoped `delivery_evidence_events`、
`delivery_evidence_attachments` 和一对一使用的 `delivery_evidence_attachment_links`。事件绑定 exact
org/store/delivery order/task/leg/task version/assignee，类型固定为 `pickup | delivered | exception`；异常
只允许受控 reason。GPS 只保存 E7 经纬整数、毫米精度整数和采集时间。数据库只保存附件 opaque
storage key、SHA-256、MIME、整数大小和时间；字节只存在专用私有 durable 子目录。

三表只追加。`laundry_app` 只有 SELECT/INSERT，显式失去 UPDATE/DELETE/TRUNCATE；行、statement trigger
即使维护角色误操作也拒绝修改。插入 guard 用会话 GUC 固定 actor，以数据库时间覆盖 created/recorded/
linked/expiry，并在锁内重验当前 accepted task 的 exact 版本、腿、订单和 assignee。三表 FORCE RLS、
组合外键和 store policy 同时阻断跨 tenant/store 引用。

### 2. 一个权威命令原子记录与完成

冻结面新增一个 R3 写 `delivery.evidence.record` 与一个 R2 读 `delivery.evidence.list`，从 68/47 增至
**69 commands / 48 queries**。输入 strict Zod exact keys，只允许整数范围、受控枚举、最多四个 UUID
附件引用和 `record_only | complete_leg` outcome；客户端不能提交租户、员工、地址、电话、路线正文、
存储 key、摘要或文件字节。两者 online-only、PII-linked、不会进入只读 AI 工具面，并投影到确定性
OpenAPI。

锁序固定为 `delivery_order -> delivery_task -> attachment`。`complete_leg` 时，事件、附件链接、订单推进、
0057 任务收口、audit、持久幂等与领域 event 属于同一个命令事务；客户端没有“先完成、后补证据”的
第二入口。取件完成必须有 GPS + photo；送达完成必须有 GPS + photo + signature。异常只能追加、不能
完成腿。数据库延迟完整性与订单 completion trigger 重复强制同一规则，因此绕过 Server 也不能制造无证
据完成。

### 3. 服务端冻结确认与非秘密投影

R3 首跳从锁内权威状态派生完整确认卡：证据/订单/任务完整 ID、两侧版本、腿、assignee、事件、outcome、
受控原因、采集时间、是否有 GPS、照片/签名计数和附件集合摘要。卡不含坐标、attachment ID、存储 key
或文件内容；二跳仍只提交 `confirm_ref`，服务端重新构建并比较 exact authority。

audit/event 只含证据/订单/任务 ID、腿、任务版本、事件、outcome、受控原因和完成后的版本，不含 GPS、
附件引用、媒体元数据、storage key、地址、电话或其他 PII。失败与业务事务一起回滚，event 仅 commit 后
发布。

### 4. 专用认证媒体边界

附件使用 `POST /api/v2/delivery-evidence/attachments` 与
`GET /api/v2/delivery-evidence/attachments/{attachmentId}`。上传要求 bearer session、双提交 CSRF、
`delivery_write`、配置 tenant、20/min 专用限流、严格 query、8 MiB body 上限、magic-byte 解码与安全重编码。
文件先以原子 no-replace 方式落盘，再注册元数据；DB 失败或竞争 replay 会按摘要清理本次文件，相同
attachment ID/相同内容安全重放，不同内容冲突。启动 sweep 只保留未过期或已链接 opaque key。

下载要求 `delivery_read`，60/min，并重新证明同 tenant/store、附件已链接、任务仍属于请求员工且状态为
accepted/completed；返回 `private, no-store`、`nosniff`，URL 和 JSON 永不暴露 storage key。该路由与表不
复用或放宽 `garment_photos`。

### 5. 移动 H5 明确动作与旧响应隔离

accepted 任务继续用原按钮开始取件/开始送回，但完成按钮移交证据卡。定位只在点击“采集本次 GPS 定点”
后发起一次高精度请求；照片/签名只在点击文件选择后读取和上传，不请求后台或大范围权限。任务选择、
版本、session/store/staff/permission scope、online 状态和表单变化分别通过 generation + AbortSignal 使旧
list/media/mutation/confirmation 失效。断网保留同会话最后读取供核对，但不排队、不乐观写、不自动重放。

确认卡展示完整非秘密 authority；成功后重读列表/详情。列表只显示是否有 GPS、照片/签名计数和受控
原因，不展示坐标或隐藏存储信息。

### 6. 隐私保留与清理裁决

顾客隐私导出仅增加 `delivery_evidence_count`、`delivery_attachment_count` 及两个受控裁决：已链接证据作为
运营证据保留；未链接私有文件在过期后清理而追加式元数据保留。导出不包含坐标、照片、签名、附件 ID、
摘要或 storage key。匿名化继续清除顾客/订单 PII，交付证据以 opaque 订单关系和上述裁决保留。

## 验收

1. Contracts 精确冻结 69/48，strict schema、红action、非 AI 与确定性 OpenAPI 通过。
2. `0001 -> 0058` 从空库 apply/replay；真实 PG 证明 accepted exact assignee、DB 时间/RLS、必需证据、
   原子 order/task 收口、append-only 和 DELETE/UPDATE/TRUNCATE 拒绝。
3. memory 与 PG store、R3 冻结、持久幂等、audit/event 同事务和隐私计数有 focused 回归。
4. 私有上传/下载验证认证、CSRF、RBAC、限流、类型/大小、相同 replay、失败清理和重新授权。
5. 移动 H5 验证明确定位/文件动作、pickup/return 必需证据、完整确认卡、scope/selection/offline/
   AbortSignal 失效与完成后重读。
6. focused Contracts/Domain/DB/Server/Web、lint/type/build、SPA、diff/size/secret 及真实 PostgreSQL 必须
   绑定最终候选；Browser、required CI、合入与 hk-vps exact-SHA 发布仍需后续独立证据。

## 后果与否决

- 证据与路线/任务各有单一真源；证据完成命令只推进既有订单状态机，不创建第二条路线。
- 媒体和坐标属于敏感现场数据，运维需备份专用私有目录并执行孤儿 sweep，AI/审计/事件不可复制。
- 否决复用 `garment_photos`、客户端先完成再补证据、自由地址/电话/路线/异常文本、base64 入库、后台
  定位、离线写队列、只凭旧 `confirm_ref` 续跑，以及匿名化时无裁决地物理抹除追加式证据。
