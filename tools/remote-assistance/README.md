# 受控协助支持端客户端

此目录是现有 HTTPS 支持端的独立命令行客户端，不托管 broker，也不签发或伪造人员身份。门店端需安装支持 ADR-89 的 Windows Runtime，并由管理员重新输入密码开启一小时只读协助。

先构建本仓库的 server 及工作区依赖，然后在本机运行：

```sh
node tools/remote-assistance/support-client.mjs < /private/path/request.json
```

请求从 stdin 读取，最多 16 KiB、十秒截止；勿将令牌或签名证明放入命令行。请求文件仅授权当前用户读取。工具成功时只输出严格校验的 JSON，失败只输出固定错误码。

每个请求包含 `trust`、`operator_access_token`、`session_id`。`trust` 为版本 1 的公共信任配置：`broker_url`（HTTPS origin）、`issuer`、`audience`、`kid`、`public_key_spki`（Ed25519 SPKI DER 的 Base64）；这里没有门店端接入令牌。

支持三个操作：

1. `operation: "challenge"`：从 `/v1/support/challenge` 获取当前协助 ID 对应的一次性 nonce 与截止时间。支持端须认证人员 access token，并确认有权支持该门店。
2. `operation: "submit"`：另附 `nonce` 与外部身份系统签发的 `proof`。先在本机验证签名、issuer/audience、时效、MFA、协助 ID 和 nonce，再提交 `/v1/support/submit`。成功返回命令 ID。
3. `operation: "result"`：另附 `request_id` 和三项白名单之一 `command`，向 `/v1/support/result` 读取结果。尚未回传时 `ready:false`；成功时仅返回对应命令允许的健康、版本或维护次数字段，未知字段直接拒绝。

门店端使用 `/v1/assistance/poll` 与 `/v1/assistance/result` 主动出站。支持端必须按角色区分门店接入令牌与支持人员 access token，隔离会话，保留 nonce 一次性语义与命令 ID，验证外部身份系统真实 MFA 后签发 ADR-89 规定的绑定证据。端点协议及声明字段见 [ADR-89](../../docs/adr/2026-10-03-adr-89-controlled-remote-assistance.md) 和 `apps/server/src/remote-assistance/protocol.ts`。

本轮未部署 broker 或身份系统；缺少这些外部条件时门店端默认关闭。测试使用临时 Ed25519 密钥和合成数据，不能据此声称生产 MFA 或真实支持端已验收。
