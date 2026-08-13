# ADR-60：固定端点 Provider Adapter 与 BYOK 连接验证

- 状态：**Proposed**
- 日期：2026-08-13
- 范围：Stage 4.5 Item 13
- 依赖：[ADR-06](2026-07-19-adr-06-byok-provider-network-key-mgmt.md)、[ADR-57](2026-08-13-adr-57-byok-custody-model-registry.md)、[ADR-58](2026-08-13-adr-58-bounded-ai-streaming-runtime.md)

## 决策

实现三种 typed provider adapter：DeepSeek 的 OpenAI-compatible Chat Completions、Anthropic Messages、
Gemini GenerateContent。每个 adapter 只允许代码内固定的 HTTPS endpoint；生产传输在请求前解析全部
地址并拒绝私网、loopback、link-local、保留地址和非 allowlist host，再把 TLS socket lookup 钉到已验证
地址。客户端不接受 base URL、header、redirect 或 credential。

凭据只能来自 ADR-57 envelope：adapter 获得短租 callback，不获得可保存/导出的 key；每次短租在
`finally` 清零。连接验证是 admin-only、CSRF、独立限流的 R3 两跳：第一跳冻结 pending credential 的
引用、provider、credential/row/model registry 版本与模型；第二跳才访问 provider，模型确实存在后在同一
事务重验 session、feature flag、冻结卡和所有 CAS，再消费卡并把凭据原子切到 active。失败、模型缺失、
版本漂移或权限漂移均不激活，外部只返回固定安全码。

协议层把文本、tool call、usage 和终止原因归一化到 ADR-58 port；响应总量、JSON/SSE schema、超时、
abort 与错误集合有界。默认 composition 不注入推理 adapter，AI 仍 hard-off。真实 smoke 只允许
`DEEPSEEK_API_KEY_FILE` 指向 owner-only、非链接的单行文件；允许一个尾随 LF/CRLF，原 Buffer 随即清零，
输出仅含状态、usage 与 tool-call 结论。

官方协议依据：

- DeepSeek：[Create Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)
- Anthropic：[Messages](https://platform.claude.com/docs/en/api/messages/create)、[Streaming Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)
- Gemini：[Models](https://ai.google.dev/api/models)、[GenerateContent](https://ai.google.dev/api/generate-content)
- OpenAI-compatible 模型发现形状：[Models API](https://developers.openai.com/api/reference/resources/models)

## 理由

固定 endpoint 消除 BYOK 设置成为 SSRF/redirect 入口的可能；短租凭据维持 Item 12 的 non-export authority；
模型发现与 registry capability projection 分离，避免把供应商自报能力提升为本地可信能力。R3 冻结卡和
第二次 CAS 防止在慢网络请求期间替换 credential/model/session 后仍错误激活。

## 否决的备选

- 直接使用供应商 SDK：拒绝。SDK 的重试、redirect、遥测和网络选项不满足本项可证明边界。
- 允许 Owner 填 base URL：拒绝。自定义 OpenAI-compatible host 需另行 ADR 与更强 egress policy。
- 发现任意模型就激活：拒绝。选中模型必须出现在本次发现结果中。
- 从环境变量直接读 key：拒绝。产品只用加密 envelope；文件入口仅供 root 主导的显式 smoke。

## 后果

- 不新增迁移；复用 0064 的 pending/active transition 与既有 pending action/audit。
- Item 14 可使用生产 adapter port，但默认仍不自动选 credential/model。
- Item 15 业务只读助手、Item 18 完整计费/红队与任意自定义 provider 均不在本 ADR。
