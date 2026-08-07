# ADR-25：会员账户冻结、解冻与原子关户

- 日期：2026-08-07
- 状态：**Accepted**
- 决策者：manpengan
- 前序：[ADR-17：会员储值](2026-07-31-adr-17-member-stored-value.md)、
  [ADR-18：储值核销单列](2026-08-01-adr-18-stored-value-settlement-reporting.md)、
  [ADR-22：储值二期](2026-08-01-adr-22-member-stored-value-phase-2.md)
- 门禁依据：[ADR-16 §2、§4](2026-07-31-adr-16-edge-operations-scope-ratification.md)
- 交付范围：Linux 本地 Server + Web；macOS、云与 Windows 继续后置

## 背景

ADR-17/ADR-22 已交付开户、充值、余额结账、充值赠送与本金退款，但账户状态仍只有
`active | frozen` 的早期占位，既没有冻结/解冻命令，也没有结束账户的完整动作。

这留下三个柜台缺口：顾客挂失时不能立即停用余额；误冻结后没有受控恢复；顾客退卡时，
普通 `member.refund` 只能退本金，赠款会留在一个仍可消费的活动账户里。若由浏览器依次
调用「退本金 → 清赠款 → 改状态」，任一步失败都会留下半完成资金状态。

本文中的“账户”是 ADR-17 的组织级储值账户，不代表已经发行实体会员卡。挂失只是本地
柜台用语，不引入卡号、卡介质或制卡系统。

## 决策

### 1. 三态账户，`closed` 为终态

冻结以下状态机：

| 当前状态 | 动作     | 下一状态 | 说明                                       |
| -------- | -------- | -------- | ------------------------------------------ |
| `active` | freeze   | `frozen` | 停止一切普通资金使用                       |
| `frozen` | unfreeze | `active` | 仅恢复同一个账户，不移动资金               |
| `active` | close    | `closed` | 结清后永久关闭                             |
| `frozen` | close    | `closed` | 挂失账户也可由管理员完成结清               |
| `closed` | 任意动作 | —        | 终态，不允许解冻、重开、充值、消费或再退款 |

`frozen` 阻止 `member.topup`、`member.balance.pay` 与普通 `member.refund`。冻结态仅允许
受权解冻或原子关户。`member.account.open` 不得借幂等语义重新激活已关闭账户；再次入会需
以后单独裁决。

每个账户新增正整数 `status_version`。每次成功转换在事务内递增版本，并记录
`status_changed_at`、`status_reason`、操作职员和门店。升级前的旧账户没有状态变更证据，
因此时间与理由允许成对为 `NULL`；发生第一笔生命周期动作后必须完整留痕。

### 2. 新增三条在线命令

| 命令                      | 风险 | 权限                                             | 允许的当前状态      |
| ------------------------- | ---- | ------------------------------------------------ | ------------------- |
| `member.account.freeze`   | R3   | `member_freeze`                                  | `active`            |
| `member.account.unfreeze` | R3   | `member_lifecycle_manage`                        | `frozen`            |
| `member.account.close`    | R4   | `member_lifecycle_manage` **且** `member_refund` | `active` / `frozen` |

三条命令全部 `offline_mode = denied`。冻结/解冻改变顾客资金的可用性；关户还会把真实本金
付出店外，均不能依赖离线设备的旧余额或旧状态。R4 关户沿用另一位管理员现场 PIN 复核与
冻结 `confirm_ref`，不能由前端角色显示逻辑代替服务端权限判断。

三条命令共享以下严格入参：

- `account_id`、`expected_customer_id`：同时钉住账户与当前顾客，防止页面切换后误操作；
- `expected_status_version`：正的安全整数，拒绝包括 ABA 在内的旧页面提交；
- `reason`：去除首尾空白后 1–256 字符；命令元数据对 `/reason` 做遮罩。

租户、门店、操作职员与服务器时间只从服务端会话注入，不接受客户端提交。

### 3. 关户是一个不可拆分的资金事务

`member.account.close` 额外接受并冻结：

- `expected_status`：仅 `active | frozen`；
- `expected_principal_cents`：0–5,000,000 整数分，也是 R4 金额度量与硬上限；
- `expected_bonus_cents`：非负安全整数；
- `refund_tender`：`cash | wechat | alipay | other | null`。本金大于 0 时必须有渠道，
  本金等于 0 时必须为 `null`。

服务端在同一个 PostgreSQL 事务内执行且要么全部成功、要么全部不发生：

1. 以会话组织锁定账户行，复核顾客、状态和 `status_version`；
2. 锁内从只追加账本重新求和，并与两个预期余额字段逐分比较；
3. 剩余本金大于 0 时追加一条全额负向 `refund`，保留退款渠道；
4. 剩余赠款大于 0 时追加一条全额负向 `bonus_forfeit`；该行的 principal 为 0，且
   `order_id`、`tender`、`bonus_rule_id` 与冲正引用均为 `NULL`；
5. 把账户改为 `closed`、递增版本、写状态证据，并与资金变更同事务写审计。

关闭后本金、赠款与总余额必须同时为 0。没有本金时不伪造零金额退款行；没有赠款时不
伪造零金额没收行。`bonus_forfeit` 只表达顾客主动关户时未使用赠款终止，不是现金支出、
订单业绩、余额到期或可提现价值。

普通 `member.refund` 继续用于活动账户的部分/全部本金退款，不会没收赠款，也不会关闭
账户。关户不得在 Web 中拼成普通退款与状态命令的顺序调用。

### 4. 复用查询，冻结结果投影

不新增查询；`member.account.get` 升至 1.1，继续按顾客读取账户与最近 50 条账本。账户
投影严格包含：

- `account_id`、`customer_id`；
- 精确状态枚举 `active | frozen | closed`；
- `status_version`、可空的 `status_changed_at` / `status_reason`；
- `principal_cents`、`bonus_cents`、`balance_cents`，且总额必须等于前两者之和。

最近账本的 `kind` 扩为
`topup | pay | reversal | refund | bonus_forfeit`，并继续返回门店、渠道、赠送规则、
订单、营业日和备注等既有字段。结果对象拒绝未知字段、重复 `ledger_id`、关闭账户非零余额
以及形态不合法的 `bonus_forfeit`，避免 UI 把新状态静默降级成 `active`。

### 5. 合并与后置边界

顾客资料合并严格沿用 ADR-17 §9：只有一侧有会员账户时，把该账户重新关联到保留顾客；
双方都持有会员账户即拒绝，不因其中一边余额为零而自动求和、丢弃或关闭任一账本。双账户
合并继续后置专门裁决，关户命令不能作为客户合并的隐式副作用。

本片仍不包含：

- 实体会员卡、卡号、补卡与卡介质绑定；
- 会员等级、积分、余额有效期或自动过期；
- 双方都有会员账户的自动合并或跨组织转赠；
- 已关闭账户重新入会或另开新账户；
- 微信/支付宝商户接口、原路退款 API 或新的支付渠道。

入参中的 `wechat` / `alipay` 仍只是现有线下记账渠道，不代表已接入支付机构。

另有一个既存缺口不归本片冒充解决：ADR-22 §3.2 要求充值 R3 首跳返回服务端冻结的精确
赠款额与命中档位，当前命令总线首跳实际只返回 `confirm_ref`；Web 只能明确展示本金、渠道，
并提示赠款在执行时由服务端计算。精确赠款/档位确认摘要仍待修，不得以本次生命周期交付
标记为完成。

## 契约冻结影响

- 命令：36 → **39**，新增 freeze、unfreeze、close 三条命令。
- 查询：保持 **22**；复用 `member.account.get`，版本 1.0 → 1.1。
- `m2-freeze.test.ts`、OpenAPI、CHANGELOG、README 与被旧文字推翻的验收记录同批更新。

## 后果

- 生命周期、余额核对、两条账本追加、状态写入与审计共享同一事务边界。
- `status_version` 防止状态 ABA；关户另用 `expected_principal_cents` /
  `expected_bonus_cents` 防止余额漂移。任一冲突都要求重新读取、重新确认，不能由服务端
  猜测重试。
- 关户明确结束未使用赠款，但不会删除顾客、订单、原账本或审计历史。
- 首期只验 Linux 本地 Server、真实 PostgreSQL 与 Web；macOS App 不因本 ADR 恢复开发。

## 否决的备选

- **浏览器依次退款、清赠款、改状态**：中途失败会产生半关户，否决。
- **冻结后仍允许普通退款或充值**：旧页面与多个柜台可绕过挂失目的，否决。
- **关闭后允许解冻或 `account.open` 复活**：终态账本与新一轮会员关系混在同一账户，否决。
- **赠款记成现金退款**：顾客未为赠款支付现金，会污染钱箱和真实收入，否决。
- **只比较余额、不比较状态版本**：状态经历冻结再解冻后可能回到同一文本值，旧确认仍会
  被错误接受，否决。
- **把实体卡、积分、有效期一起实现**：三者有独立身份、激励和法规问题，会扩大本片资金
  风险，否决。
