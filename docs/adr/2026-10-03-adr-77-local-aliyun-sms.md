# ADR-77：Windows 本机阿里云短信适配

- 状态：软件实现与独立审查通过，待 Windows 安装验证和服务商账户验收
- 依据：ADR-72；manpengan 指定阿里云短信；Cloud 保持暂停。

## 决策

1. 通过固定 `dysmsapi.aliyuncs.com` HTTPS 端点和 ACS3 HMAC-SHA256 调用
   `SendSms` 与 `QuerySendDetails`。不接受自定义 URL、不跟随重定向，响应、超时和分页都有上限。
2. 复用现有在线催取预览、确认、费用上限、批次队列和审计，不新增总线命令。
   单机提供方只绑定服务端配置的 org/store。设置入口为管理员专用固定 HTTP/IPC 操作，
   每次保存重验管理员密码、当前会话与权限，使用版本比较并把配置变化和审计放在同一事务。
3. AccessKey 仅经密钥输入入口进入后端，采用 AES-GCM envelope 和 Windows CurrentUser
   DPAPI 包装数据密钥；通知和 AI 使用不同的附加熵域。UI、审计、诊断不返回密钥。
   换机导出排除 `notification_provider_settings`，新机器重新配置。
4. 阿里云 `OutId` 是关联标识，并不提供发送幂等保证。此适配显式声明至多一次发送：
   任何超时、未知响应或已被重新认领的尝试均转人工处理，保留未知费用预留，绝不自动重发。
   已接受发送按手机号、模板和 OutId 三项同时匹配后记录送达/失败回执；不把 API 接受等同送达。
5. 待处理短信存在时禁止变更签名、模板、费用；允许保留发送配置的启停与凭据轮换，
   以便及时替换失效或泄露的 AccessKey。轮换不会清除未知结果及费用预留，也不会重发旧批次。
   旧已接受批次继续按原模板和 OutId 查回执；若换成不同阿里云账户而无法查询，保留人工处理状态。
   停用后仍可查看历史批次。回执轮询记录进度，避免长期等待的收件人阻塞其它回执。

## 软件验证与尚未具备的外部条件

签名使用阿里云公开示例作为独立期望值；模拟网络验证固定端点、无重试、取消、超大响应、
回执三项匹配与不完整分页。真实 PostgreSQL 验证配置隔离、管理员重认证、版本竞争、密文存储和审计原子性。
测试均使用合成凭据与合成顾客，不发送真实短信。

本 ADR 不代表实际阿里云账户、已批准签名/模板、真实回执和费用验收已完成。
微信订阅通知接续 B4 原生小程序身份和用户授权流程，不能由短信适配代替。

## 参考

- [SendSms](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-sendsms)
- [QuerySendDetails](https://help.aliyun.com/zh/sms/developer-reference/api-dysmsapi-2017-05-25-querysenddetails)
- [ACS3 请求签名](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)
