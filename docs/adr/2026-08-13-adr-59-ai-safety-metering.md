# ADR-59：AI 安全、整数计量与失败降级

- 状态：**Proposed**
- 日期：2026-08-13
- 范围：Stage 4.5 Item 18
- 依赖：[ADR-06](2026-07-19-adr-06-byok-provider-network-key-mgmt.md)、[ADR-58](2026-08-13-adr-58-bounded-ai-streaming-runtime.md)

## 背景

流式会话已经具备 provider-neutral 生命周期，但生产启用仍缺少成本权威、组织级预算、连续失败熔断、
PII 防泄露、SSRF 出口约束与 prompt injection 门禁。任何一项缺失都不能通过“provider 已配置”推导为
AI 可安全使用。

## 决策

### 1. 默认关闭与整数成本账本

公开 runtime 继续 hard-off。未来即使注入 provider，组织仍必须存在 owner 管理的 enabled 安全策略；
缺失策略按预算不可用失败关闭。token 与估算成本逐 turn 只追加，成本使用整数 micros，价格保存为每百万
token 的整数 micros 快照，不使用浮点或货币类型。`ai_usage_daily` 只保存日聚合，Owner HTTP/UI 只读
当前月整数汇总，不暴露 prompt、response、key 或 provider payload。

开始 turn 前，以组织 advisory lock 原子计算当月已用成本和未释放 reservation；最坏 input/output token
预算超限即拒绝。完成 turn 时同一事务核对服务端成本、释放 reservation、追加 usage、更新日账和终态审计。

### 2. 持久熔断与安全降级

连续三次 provider failure 打开组织熔断器五分钟。预算或熔断拒绝不会尝试 provider，也不会绕到浏览器、
其他模型或任意网关；会留下固定 reason 的安全事件，并以封闭 terminal error 降级。成功完成会复位连续
失败。超时、用户取消和本地输出上限不计为 provider 故障。

### 3. PII 与 prompt injection

输入在落库及交给 provider 前统一遮蔽手机号、证件号、邮箱、长账号和疑似 token；输出使用跨 chunk
尾缓冲后再遮蔽，持久 event、SSE、assistant message 和审计均只看见遮蔽文本或计数/hash。PII masking
在本 Item 固定开启，API 不提供关闭开关。

中英文 injection 红队样本覆盖忽略 system/developer、泄露提示词/密钥、绕过授权和调用未授权工具。
命中后在创建 turn 前拒绝，并只审计脱敏后 SHA-256 与固定 reason。检测器是纵深门禁，不替代 Item 14
的 tool allowlist、Zod 参数校验和权限边界。

### 4. SSRF 边界

provider-neutral 出口验证器只接受 allowlist 中的 ASCII DNS hostname、HTTPS、443、无 userinfo、无
fragment、无 IP literal。每个初始 URL 和 redirect hop 都必须重新解析；DNS 结果为空或包含 loopback、
RFC1918、CGNAT、link-local、ULA、IPv4-mapped private 等地址即拒绝。调用方只能连接验证器返回的固定
地址，不能二次解析 hostname。Item 18 不实现外部网络或真实 provider 调用。

## 否决的备选

- 仅在 UI 统计 token：断连、并发和多实例会失去成本权威。
- 完成后才检查月限额：并发 turn 可同时越过预算。
- 把 provider error 原文回传：可能泄露 endpoint、key、payload 或内部网络信息。
- 只检查 URL 字符串或首个 DNS 结果：不能抵御私网地址、混合答案与 rebinding。
- PII 只在日志层遮蔽：prompt、持久消息、SSE 和 tool-result 仍会泄露。

## 后果

- 0066 必须接在 0065 后；发布时仍需在完整 0054–0065 集成链重新运行真实 PostgreSQL 门禁。
- Owner 面只读展示 runtime、月 token/成本、限额、熔断和固定隐私/出口策略；策略写入仍是 owner-only
  运维/后续专用高风险能力，不在本 Item 新增普通 command/query。
- 本 Item 的 fake 与红队证据不等于任何真实 provider、真实 API key、外部网络或生产 AI 已验收。
