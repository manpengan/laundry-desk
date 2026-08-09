# ADR-31：新店投产、第二审批人与员工凭据生命周期

- 日期：2026-08-08
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-14：通用 V2 本地优先交付](2026-07-25-adr-14-generic-local-first-v2-delivery.md)、[ADR-16：边缘运营范围追认与契约面门禁](2026-07-31-adr-16-edge-operations-scope-ratification.md)、[ADR-21：独立 macOS Runtime.app](2026-08-01-adr-21-independent-macos-runtime-app.md)
- 影响：Runtime 首装、PostgreSQL identity/RLS、员工管理命令、Web/macOS 首次投产验收

## 背景

当前生产 bootstrap 只创建一位管理员，`store_features` 缺行时会员与交班默认关闭；员工新增、
第二审批人和 feature 初始化只存在于 E2E 直接写库夹具。常规 R5 命令又必须由另一位 active
admin 审批，因此真实空卷无法靠产品入口建立第二审批人，也无法证明新店可独立投产。

密码和 PIN 不能作为 R5 命令参数：确认卡、幂等账本、审计与调试链都不应持久化原始凭据。
同时，不能为解决首装死锁而在柜台 HTTP 面留下永久的单管理员权限旁路。

## 决策

### 1. Runtime 投产事务一次建立双管理员

全新 Runtime 安装必须通过 stdin/私有 secret file 接收两组相互独立的管理员用户名、显示名、
密码和 PIN。bootstrap 在同一 owner 事务与既有 advisory lock 内：

1. 创建固定本地组织、门店、两位 active admin 及各自 active store role；
2. 以 Argon2id 分别散列四项凭据，禁止复用同一用户名、密码或 PIN；
3. 持久化当前已交付的本地 feature profile：`fulfillment`、`membership`、
   `shift_closing` 为 true，`delivery`、`marketing`、`ai` 为 false；
4. 写入投产元数据与不含凭据的 bootstrap audit，并把投产永久标记为完成；
5. 在 app-role readiness 验证成功后删除临时 secret file。

既有单管理员安装只允许 Runtime.app 的一次性 `commission` 维护动作补齐上述第二管理员和
feature profile。该动作必须同时满足：固定本地 profile、既有 bootstrap metadata、尚未投产、
恰好一位 active admin、目标用户名未占用，并在同一 owner 事务完成；成功后永久关闭。
Counter/Web/Fastify/AI 均不暴露该 owner 权限。

密码限制统一为 12–256 个字符，PIN 为 6–8 位数字。生产 Runtime 不通过 argv 或宿主环境传递
密码、PIN、数据库密码或私钥。

### 2. 日常员工元数据继续走命令总线

新增两个冻结 R5 命令：

- `staff.create`：仅接收 username、display name、role、privacy authority 与 reason；
- `staff.credentials.reset`：仅接收 target staff、expected permission version 与 reason。

两者均要求 `rbac.staff_write`、另一位 active admin 的 step-up、持久幂等和事务审计，且离线
拒绝。`staff.create` 先创建 inactive 员工/角色；reset 先提升 permission version、撤销目标全部
session/refresh family 并令目标 inactive。自操作、最后管理员、最后 privacy admin、跨租户、
版本冲突和重复用户名均失败关闭。

命令结果只返回非秘密的 `credential_setup_ref`、目标 staff id、到期时间与状态。setup ref 是
随机 UUID 查找键，不是独立 bearer authority；它必须与原命令发起人、租户、门店、目标员工、
用途和到期时间绑定。

### 3. 原始凭据只进入受控完成边界

新增严格认证的 `POST /api/v2/auth/staff/credentials/complete`。请求只接受
`credential_setup_ref`、新密码和新 PIN，并必须同时满足：

- 当前 access session 有效、CSRF 通过、当前 actor 仍是 active admin 且有 `staff_write`；
- actor 与 setup ref 的命令发起人一致，org/store/staff/purpose 全字段一致；
- setup ref 未过期、未消费，且目标仍处于对应 inactive credential state；
- 密码/PIN 在事务外完成有界 Argon2id 计算，事务内再次 `FOR UPDATE` 校验并单次 CAS 消费；
- staff/role 激活、credential version 更新、setup 消费和无秘密 audit 在同一事务提交。

密码、PIN、散列、Cookie、token 和 setup 内部状态不得进入命令卡、幂等结果、事件、日志、
支持包、截图或证据 manifest。完成接口启用 `no-store`、固定错误信封、请求大小限制与每会话
有界速率限制；错误不区分 ref 不存在、过期、已消费或 actor 不匹配。

### 4. UI 与验收以真实空卷为准

Runtime 安装/一次性投产界面必须明确收集两位管理员的独立凭据并在提交前做本地校验；日常
Settings 提供员工新增、重置和凭据完成表单。所有秘密输入使用可见 label、首错聚焦、
`aria-live` 状态和至少 44px 触控目标；PIN 使用 numeric input mode 且允许粘贴。

员工创建/重置/完成后客户端重新 refresh session 与 staff directory，不依赖登录时旧快照。
Browser 与 packaged macOS 验收必须各用独立新 volume，从生产 bootstrap 开始，不得依赖
`global-setup` 直接插员工、复制密码散列或修改 feature。

## 后果

- 新店首装天然具备双人审批与会员/交班功能，不再有 R5 启动死锁。
- Runtime 保留唯一、可审计、投产后不可重开的 owner 维护入口；柜台服务不获得数据库 owner。
- 日常员工生命周期遵守命令总线与双人审批，同时原始凭据永不进入 durable command 数据。
- 既有安装升级后必须先在 Runtime 完成一次 commissioning，才可宣称投产闭环完成。
- 本 ADR 新增两条命令和一条认证生命周期 HTTP 边界；按 ADR-16 同批更新冻结清单、OpenAPI、
  CHANGELOG 与空卷验收。

## 否决的备选

- **首装后由唯一管理员在 Web 直接创建第二管理员**：形成常驻或难以证明关闭的权限旁路，否决。
- **把新密码/PIN 放进 R5 命令或 confirmation args**：会进入持久确认/幂等边界，否决。
- **由首管理员设置所有员工的长期初始密码并复制散列**：无法证明独立凭据与操作者归属，否决。
- **继续依赖测试 SQL 初始化员工和 feature**：不能构成产品交付或 packaged 空卷证据，否决。
- **把投产、staff 管理或凭据完成开放给 LAN Owner 页面**：扩大只读 LAN 信任边界，否决。
