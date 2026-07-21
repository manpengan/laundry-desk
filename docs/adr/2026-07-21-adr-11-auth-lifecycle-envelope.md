# ADR-11：身份生命周期信封与认证来源

- 日期：2026-07-21
- 状态：**Accepted**（manpengan 已书面授权 Codex 负责后续架构裁决与交付）
- 补充：ADR-02 #10、ADR-05 #1；不回改既有 Accepted ADR 正文

## 背景

ADR-05 要求所有写操作走 Command Bus 与统一审计边界，ADR-02 又禁止客户端自报 actor/tenant。
但 `identity.login` 尚无认证 session，`identity.refresh` 可能发生在 access 过期后；若强塞进 A2
`ServerCommandEnvelope`，只能伪造 actor/tenant。另一方面，Edge replay 的可信来源是设备会话与
server 验证的 grant/lease，不是浏览器 session。

## 决策

1. **不伪造认证上下文。** login、refresh 与基于 refresh session 的 logout 使用窄化
   `IdentityLifecycleEnvelope`，它没有 actor/tenant 字段，只有有来源登记的 HTTP/设备入口元数据。
2. **仍走同一总线基础设施。** lifecycle 入口必须使用注册表输入 schema、固定错误信封、限速、
   原子事务、安全事件审计和领域事件；只是认证前置链不同，不得直调 identity service 绕过总线。
3. lifecycle 操作固定为 `identity.login | identity.refresh | identity.logout`，不进入 AI Tool Registry，
   不允许 automation/Edge replay/offline，不接受 dry-run/confirm_ref。
4. login 链为 Origin/Fetch Metadata → 限速 → 凭据验证 → session/family 原子创建 → 安全事件审计；
   refresh/logout 链在 Origin/CSRF 后先解析 refresh session，再原子轮换或撤销。
5. 成功认证后，C6/C8 才可通过私有 authority 创建 `browser_session` snapshot。普通 A2
   `ServerCommandEnvelope` 接受有 provenance 的判别联合：
   - `browser_session`：active/version 已复核的 A5 session，`via` 仅 ui/ai/automation；
   - `edge_replay`：设备会话与 A4 grant/lease/queue 已复核的 snapshot，`via` 固定 edge_replay。
6. 同形 JSON、客户端字段和错误的 `via + provenance` 组合全部拒绝；apps/server 架构 lint 只允许
   auth/edge ingress 模块持有对应 authority。
7. A2 错误信封补充固定 `AUTHENTICATION_FAILED`、`CSRF_REJECTED`、`RATE_LIMITED`，HTTP 分别为
   401/403/429；不得复用 RBAC 或资源缺失错误掩盖协议语义。

## 后果

- ADR-05 的“唯一写入口”继续成立：身份生命周期仍经 bus、事务与审计，只是不能假装已经认证。
- A5 必须同时调整 A2 server-envelope 与错误表，并导出 A7 可投影的 auth operation matrix。
- C6/C8 需要两种窄入口和来源 authority；任何数据库/密码学实现仍不进入 contracts。
