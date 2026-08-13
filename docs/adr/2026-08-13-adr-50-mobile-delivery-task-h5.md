# ADR-50：配送员/员工移动 H5 我的任务工作台

- 日期：2026-08-13
- 状态：**Proposed（实现候选与本地 Web 门禁已完成；本批未执行独立安全审查，待 manpengan 签署）**
- 决策者：manpengan
- 路线：[ADR-37：Cloud Web 主交付形态](2026-08-10-adr-37-cloud-web-primary-delivery.md)
- 前置：[ADR-49：权威配送任务](2026-08-13-adr-49-authoritative-delivery-tasks.md)
- 契约门禁：[ADR-16：边缘运营范围与契约面](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 影响：Web browser host、认证恢复、移动任务 UI、HTTP request authority、同步 SPA；不影响 Contracts、Server 或数据库

## 背景

ADR-49 已交付员工桌面“取送”页面及权威任务链，但该页面同时承载管理员分派、转派和接管，在窄屏、
断网和现场单手操作下不能作为配送员任务面。把桌面管理面直接缩小，会让配送员看到无关管理能力，
也无法单独约束浏览器 cookie 会话恢复、旧响应和同机换员工后的 PII 清理。

阶段 4.4 Item 5 因此只新增一个面向手机浏览器的“我的任务”客户端。任务、订单、权限、确认、幂等和
租户真源全部复用 ADR-48/49；本 ADR 不新建 API、契约、数据库表或迁移，也不提前实现 Item 6 的路线、
GPS、照片、签名或交付证据。

## 决策

### 1. 精确浏览器入口与会话边界

移动任务面只由精确路径 `/mobile/tasks`（及尾斜杠）选择；`/mobile`、子路径、大小写变体和其他路径都
不进入该面。它是 Cloud Web 同源 SPA 的 browser-only 路由，不复用 ADR-26/27 的 Owner LAN gateway，
也不改变 Electron/Runtime 默认 Counter surface。

未登录时复用既有用户名/密码安全登录。该精确移动入口可用现有 refresh + CSRF cookie 做冷启动恢复；
access token 仍只存在 browser host 私有 closure，不进入 React、Web Storage、URL 或日志。普通浏览器
Counter 和 `/owner` 明确不触发静默 refresh；桌面原有恢复保持不变。退出、认证失败、session/store/
staff/permission 变化先撤销客户端 authority 并清空任务详情与确认，再撤销服务端会话。

### 2. 只复用现有 68/47 契约面

移动面只调用四个既有边界：

| 边界                        | 用途                         | 客户端约束                                |
| --------------------------- | ---------------------------- | ----------------------------------------- |
| `delivery.tasks.list`       | 我的有界任务列表             | 固定当前 `staff_id`，active/all，最多 100 |
| `delivery.task.get`         | 当前任务详情                 | 必须仍属于当前员工和当前门店              |
| `delivery.order.get`        | 订单真源与可执行状态         | 必须与任务的 `delivery_order_id` 完全一致 |
| `delivery.task.respond`     | 接受或带受控原因拒绝 offered | R3、任务 CAS、服务端冻结 task summary     |
| `delivery.order.transition` | 推进 accepted 任务对应的腿   | R3、订单 CAS、只能走下表固定边            |

可执行边固定为：

```text
pickup + pickup_scheduled  -> pickup_in_progress
pickup + pickup_in_progress -> picked_up
return + return_scheduled  -> return_in_progress
return + return_in_progress -> completed
```

任务不是路线真源；订单转换成功后由既有 Server/数据库规则收口任务。管理员在移动入口也只看到“我的任务”，
不出现分派、转派或人工接管；这些继续留在 ADR-49 桌面员工面。UI 权限只作投影，RBAC、会话门店、任务
assignee、Server 锁内重验和 RLS 继续分别成立。Contracts 冻结数保持 **68 commands / 47 queries**。

所有列表、详情和写结果继续由现有 strict Zod schema 解析统一信封。列表只要混入非当前员工任务、任务/
订单 ID 不一致或出现 GPS/证据等未知字段，整次响应失败关闭。

### 3. 确认卡冻结完整 authority

`delivery.task.respond` 使用既有服务端 typed WYSIWYS summary；移动客户端把 summary 的订单/任务 ID、
订单/任务版本、腿、assignee、决定和受控原因逐字段绑定当前严格详情及首跳 body，二跳仍只发送
`confirm_ref`。

既有 `delivery.order.transition` 没有 typed order summary，本 Item 不为 UI 扩契约。服务端返回有效 R3
`confirm_ref` 后，客户端冻结 exact first-hop body 与当时严格解析的 authority：完整 task/order/laundry
ID、任务腿和状态、任务/订单版本、路线、当前→目标状态以及可选取消原因。确认卡完整展示这些字段；
二跳前从当前详情重新构建 body 与 authority 并逐字段生成同一 key。选择变化、详情版本变化、路线或状态
变化、session/store/staff/permission 变化任一发生，确认立即失效，绝不只凭旧 `confirm_ref` 续跑。

### 4. Generation + Abort 防止旧 PII 回填

移动面按完整 session authority 建 scope，并为 list、detail、mutation 三个 channel 分别维护单调 generation
和 `AbortController`。新请求、筛选/选择、离线、退出或 scope 替换会 abort 旧 transport；即使测试 port
忽略 AbortSignal，旧 generation 也不能写回 React state。HTTP 取消映射为独立 `REQUEST_ABORTED`，不
显示为网络失败、不自动重放写；命令客户端保留原幂等键，只允许操作员在重新核对权威状态后显式重试。

### 5. Online-only、feature-off 与移动可访问性

全部读写仍为 online-only，不增加 Service Worker、离线队列或乐观状态。网络断开时只保留同一会话最后
一次成功读取供核对，立即撤销进行中请求和确认并停用写按钮；恢复网络后自动重读。错误、格式异常、
权限拒绝、冲突和认证过期均有明确可恢复提示。`delivery_enabled=false` 只关闭新取送订单，移动面仍可
接拒并收口既有任务。

布局 mobile-first，在 720px 下切换列表/详情，在 390px 下单列；支持 safe-area、跳转主内容、语义状态、
可见 focus、状态文字而非只靠颜色、44/48px 操作目标和 reduced-motion。页面不展示顾客姓名、电话、
地址或 customer ID，也没有定位、导航、扫码、上传照片、采集签名或后台运行能力。

## 验收

1. 精确 `/mobile/tasks` 才选择移动面；browser Counter/Owner 不触发 cookie resume，desktop 恢复不回归。
2. 冷恢复只返回 token-free `SessionView`，access token 私有地供后续 query/command 使用；logout 与并发
   refresh 时旧 token、目录和 PII 不得恢复。
3. 列表和详情只接受当前员工、当前任务/订单 ID 的 strict Zod 响应；移动面不出现分派/转派/接管或
   Item 6 字段。
4. offered 可接受/拒绝；accepted 只暴露与任务腿匹配的四条订单边；feature-off 不冻结既有任务。
5. 两类 R3 首跳和二跳绑定完整 authority；选择、详情、版本、路线或 scope 变化后旧确认失败关闭。
6. AbortSignal 传到真实 HTTP transport，generation 覆盖不响应 abort 的 deferred port；取消写不自动
   重放，断网写全部停用。
7. Web focused/test/lint/type/build、文件规模和 SPA sync/check 必须有最终工作树的新鲜证据；本批产品
   裁决不另设独立 security review 门禁，也不把它记作已通过。若后续合入策略重新要求审查，必须绑定
   同一候选 diff；Browser、required CI、合入和 hk-vps exact-SHA 发布仍需后续独立取证。

## 后果

- 现场员工获得窄屏专用任务面，同时保持 ADR-48 订单真源和 ADR-49 管理面不变。
- browser 冷恢复只为明确移动入口开放，避免 Counter/Owner 的会话语义被悄悄改变。
- HTTP ports 新增可选 AbortSignal，但不改变命令/查询名称、输入、统一信封或服务端行为。
- Item 6 若加入证据，必须另立契约、隐私、保留与上传失败语义，不能向本客户端 authority 塞自由字段。

## 否决的备选

- **直接复用桌面任务面并只加媒体查询**：会把管理员分派/接管与移动执行混在一起，否决。
- **让所有 browser surface 自动 refresh**：会改变 Counter/Owner 现有显式登录边界，否决。
- **本地保存 access token 或任务缓存**：扩大凭据与 PII 生命周期，否决；仅内存 closure 和同会话快照。
- **离线排队接单或状态转换**：会让任务/订单版本和保管责任在断网时分叉，否决。
- **仅显示短 ID 后凭 confirm_ref 续跑**：操作员无法核对完整 authority，否决；冻结并重建完整上下文。
- **为移动 UI 新建重复 API/数据库列**：现有 ADR-48/49 边界已经足够，否决。
- **同时加入 GPS、照片、签名或路线导航**：属于 Item 6 的证据与隐私问题，明确后置。
