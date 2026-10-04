# ADR-90：Windows 门店微信取衣订阅通知

- 日期：2026-10-03
- 状态：实现；协议与合成 PostgreSQL 验证，真实微信账号验收待外部条件
- 范围：B1 微信真实适配，接续 ADR-86/87 小程序身份与顾客同意

## 决定

Windows 本机 API 使用微信固定 HTTPS `stable_token`、`message/subscribe/send` 接口。仅支持当前顾客关联的已就绪订单取衣提醒；不提供自由文本、任意收件人或群发入口。Cloud 平台继续暂停。开发测试注入协议替身，不发送真实消息、不产生消费。

管理员配置已批准模板 ID 与三个类型固定的字段：`character_string` 票号（最多 32 个 ASCII 可见字符）、`thing` 门店名（最多 20 个 Unicode 字符）、`phrase` 固定“可以取衣”。门店名截取后的实际内容显示在预览中；不能映射的票号拒绝。模板必须同时在当前小程序配置允许的订阅模板列表内；开发版、体验版、正式版显式选择。默认关闭。

以下命令通过既有 bus 的 R3 确认、权限、审计、幂等与在线门禁：

- `notification.wechat.settings.set`：`store_manage`，保存无密钥的模板配置与版本。
- `notification.wechat.send`：`customer_read`、`notification_send`，输入只有订单 ID 与预览摘要；确认时重查当前订单、顾客、模板版本及尚未消费的订阅。

新增查询 `notification.wechat.settings.get`、`notification.wechat.preview`、`notification.wechat.list`。M2 冻结清单同步增加 2 个命令、3 个查询。所有处理器限定 UI 来源与本机服务端租户，不加入 AI/自动营销发送路径；既有 HTTP bus 限流、会话和 CSRF 继续生效。界面按票号/取件码/手机号查询选择订单，显示实际内容，确认继续请求仅带服务端 `confirmRef`。

## 同意、权限与保密

采用顾客主动 `wx.requestSubscribeMessage` 的 `accept` 记录，一份同意只能消费一次。消费时间、outbox 关联不可逆；取消、拒绝、超时也不归还。身份从当前绑定关联，openid 仅通过 Windows KMS 解密供发送使用，不存到 outbox、审计、清晰文本导出或日志。AppSecret 复用现有小程序密钥封装；令牌只驻留当前调用内存，固定域名、禁止重定向、10 秒时限、32 KiB 回应上限。

发送前再次锁定检查小程序与通知配置版本、模板、绑定、同意、员工权限，以及未合并/匿名化顾客与订单全部可取衣状态。会话正常过期不使已同意订阅立即失效，但注销/撤销拒绝后续派发。已消费同意不依赖重新登录恢复。凭据或权限变化导致任务取消，不静默转移顾客。

## 可靠性

`0079_miniapp_notifications.sql` 新增模板配置、发送 outbox，并扩展订阅消费/撤销字段。入队、同意消费、业务审计在同一事务提交。领取时在网络发送前持久化 `sending` 与不可逆 `dispatched_at`。令牌取得失败尚无发送副作用，可稍后重取；消息发送永远只调用一次。

微信明确成功仅记 `accepted`（微信受理），不声称送达。明确拒绝记 `failed`，超时、截断、异常 HTTP 或无法解析回应记 `unknown`。进程中断留下的 `sending` 超过两分钟归为 `unknown`。任务选择仅扫描 `queued`，不自动重发未知状态；数据库阻止已派发行回到 `queued`。同订单跨模板的 `queued/sending/accepted/unknown/needs_review` 部分唯一约束阻止另消费一次同意再次发送。失败或发送前取消后，可由操作员重新预览并消费新同意。

备份恢复撤销所有旧同意，保留消费关联与派发时间，将 `queued/sending/unknown` 改为 `needs_review`，通知配置停用并提升版本。既有终态保留。恢复不复活授权，不派发旧任务；人工联系作为后续处理。

A9 清晰文本业务导出保留通知配置、订单关联、固定消息快照、状态和错误码，排除绑定与订阅权限 ID；小程序绑定、会话、订阅以及 profile authority 私钥表仍完整排除。A2 全量加密备份采用现有权限重置规则。

## 验证与外部条件

合成协议测试覆盖固定 URL/字段、受理/拒绝/未知、异常回包不重试、密钥错误脱敏。真实隔离 PostgreSQL 测试覆盖缺少配置拒绝、审计失败同意回滚、并发只入队一次、并发只派发一次、未知后额外同意不允许重发、撤销与订单变化取消、恢复后暂停和不可逆约束。Runtime 独立恢复测试覆盖七种状态、消费/派发时间保留、终态不可回退。

真实账号还需门店提供 AppID/AppSecret、获批匹配字段的模板、微信出口 IP 白名单与顾客主动订阅。该外部验收不由合成回归代替；开发不自动向真实顾客发消息。

官方参考：[微信订阅消息接口](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-message-management/subscribe-message/sendMessage.html)、[稳定版令牌](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/mp-access-token/getStableAccessToken.html)、[腾讯官方订阅示例及同意次数说明](https://github.com/TCloudBase/wxcloudrun-wxapp-subscribe)。示例仅用于核对协议，不采用其 Cloud 部署与开放收件人接口。
