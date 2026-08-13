# ADR-58：Provider-neutral 流式会话与有界 tool-use runtime

- 状态：**Proposed**
- 日期：2026-08-13
- 范围：Stage 4.5 Item 14
- 依赖：[ADR-05](2026-07-19-adr-05-ai-command-policy-approval.md)、[ADR-06](2026-07-19-adr-06-byok-provider-network-key-mgmt.md)、[ADR-37](2026-08-10-adr-37-cloud-web-primary-delivery.md)、[ADR-57](2026-08-13-adr-57-byok-custody-model-registry.md)

## 背景

Item 14 需要建立可以被后续 provider adapter 复用的流式会话边界，同时不能提前把尚未完成真实
sandbox、安全评估和模型登记的 provider 接入产品。流式连接还会引入断连、重放、背压、并发 turn、
tool 重入和输出失控等新状态，不能只靠进程内缓冲。

本 Item 因此只交付 provider-neutral port、确定性 fake、最小持久状态和 staff/admin Web 面板。
`store_features.ai` 与公开 runtime 均继续 hard-off；未显式注入测试 fake 时，不创建会话、不调用
provider，也不产生任何外部网络请求。

## 决策

### 1. 专用 HTTP 与 provider-neutral port

流式 AI 使用四个 `/api/v2/ai/sessions` 专用 HTTP operation：创建会话、创建 turn、读取有界持久事件、
订阅 SSE。它们不进入普通命令/查询总线，也不加入 AI command/tool 投影，避免解冻 ADR-16 的业务
能力边界。

Provider port 只接受 typed messages、固定 tool descriptor、token 上限和 `AbortSignal`，只输出 typed
delta/tool-call/end/error。接口不接受任意 URL、header、credential、SDK client 或 provider payload。
Item 14 唯一实现是必须显式注入的 `deterministic_fake`；生产默认值为 `null` 并返回安全的
`AI_UNAVAILABLE`。

### 2. 严格 SSE 和有界执行

SSE 固定使用 `text/event-stream; charset=utf-8`、`Cache-Control: no-store, no-transform`、keep-alive 和
禁代理缓冲。每个 event 先持久化再发送，`id` 是会话内单调 cursor；重连只接受 `Last-Event-ID` 或
严格 query cursor，并最多回放 256 条。Socket 断开会 abort provider 与 tool loop；终态仍会保存，供
下一次读取。

Runtime 同时限制：15 秒总 deadline、1024 output tokens、32768 output bytes、256 events、最多 4 次
tool step，以及每次 tool 1 秒 timeout。写入发生背压时等待 drain；close/error 会停止等待并触发取消。
错误事件只使用封闭 code，不回传 provider 错误、BYOK、prompt、tool args 或其他 PII。

### 3. Tool allowlist

Item 14 的 exact allowlist 只有 `synthetic.lookup`。它只返回确定性的合成测试数据，没有网络、数据库
业务读取、写命令或外部副作用。参数使用 strict Zod schema，持久 tool attempt 只保存输入/结果摘要、
结果类别、step 和耗时。

Item 15 的业务只读工具及任何写工具都必须另行 ADR、契约冻结、安全门禁和授权设计；provider 输出的
未知 tool name 直接失败。重连只能读取持久 event，不会重新启动 running/completed turn，因此不会重复
tool side effect。

### 4. 持久状态、租户与审计

0065 建立 `ai_sessions`、`ai_turns`、append-only `ai_messages`、`ai_stream_events`、`ai_usage` 与
`ai_tool_attempts`。组织、门店、员工和 auth session 全部由服务端会话注入；所有表启用并 FORCE RLS。
应用角色只有 SELECT 与 closed `SECURITY DEFINER` function EXECUTE，没有直接 INSERT/UPDATE/DELETE/
TRUNCATE。

创建会话、创建 turn 和完成 turn 的业务状态与 audit 在同一事务。Audit 只保存 UUID、状态、字符/事件/
token/byte/tool 计数和 SHA-256，不保存 prompt、response、message content、tool args 或 tool result。
Message 只追加；会话内同时只允许一个 queued/running turn。

### 5. 幂等、并发、限流与 UI

客户端为每个 turn 提交 UUID idempotency key。同一 session/key 与相同 prompt hash 重放原结果，不同
prompt 返回冲突；数据库 partial unique index 与 advisory lock 共同限制单 active turn。HTTP 另按组织和
auth session 做滑动窗口上限，客户端不能提交 tenant/staff/session authority。

Staff/admin Web 面板通过生成按钮开始 stream，通过停止按钮 abort。认证 session 或 scope 变化时清空
当前会话和显示内容；组件卸载也会 abort。内容只作为 React 文本节点渲染，不使用 `innerHTML`。未配置
runtime 时明确显示“AI 未配置/不可用”，不尝试降级到浏览器 provider 或读取密钥。

## 否决的备选

- 在浏览器直接调用 provider：会暴露凭据并绕过服务端租户、限流、审计和取消权威。
- 复用普通命令总线：会把尚未批准的 AI capability 加入业务契约和 tool 投影。
- 只在内存中保存 stream：断连后无法从权威 cursor 重读终态，也无法可靠阻止重复 tool 执行。
- 接受任意 provider URL/header/tool name：扩大 SSRF、secret 泄露和未授权业务执行面。
- 无限续跑 tool 或依赖 provider 自报 token：无法控制成本、延迟和资源占用。

## 后果

- 后续 provider adapter 可复用稳定 typed port 和 durable SSE lifecycle，但必须单独完成网络 allowlist、
  BYOK 解密、模型登记、成本/熔断、真实 sandbox 与隐私安全证据。
- Item 14 只证明 software-only deterministic fake 行为；它不构成任何 provider、真实模型或生产 AI 已
  配置/可用的声明。
- 0065 在集成分支仍须位于完整 0054–0064 迁移链之后再进入发布门禁；本隔离分支不伪造缺失迁移。
