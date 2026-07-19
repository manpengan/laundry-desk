# ADR-06: BYOK / Provider 网络 / 密钥管理

- 日期：2026-07-19　状态：**Accepted**（终审裁决单独签署，2026-07-19 生效）　父文档：[总 RFC](2026-07-19-v2-productization-and-ai.md)
- 详设：架构 §9.2、§9.3、§9.7

## 决策

1. **BYOK**：门店/品牌自带模型 API key；平台不转售 token、不碰模型计费资金。
2. **三协议 adapter**：`anthropic`（官方 SDK/Messages API）、`openai-compat`（OpenAI/Grok/DeepSeek/Qwen/Kimi/GLM/豆包/自托管 vLLM）、`gemini`（原生 API）。模型清单为配置驱动的注册表（`ai_model_registry`），出厂快照标注"实现时校准"。
3. **密钥契约（二轮补丁，替代"算法名"级描述）**：每凭证独立随机 **DEK**（AES-256-GCM）+ 每次加密唯一 **96-bit nonce** + **AAD 绑定 `org|provider|credential|schema_version`**（防密文挪用）；DEK 由 KEK 包装——云端 KEK 在 KMS，自托管 KEK 在 **OS Secret Store（DPAPI/Keychain/secret-service），不与数据库同盘**；密文带 `key_version`，支持 KEK 轮换重包裹、凭证轮换、吊销与灾备恢复；仅展示尾 4 位；不回明文、不进日志/错误/AI 上下文/明文备份。
4. **出口硬化（SSRF 防护）**：默认 `base_url_mode=official`，仅允许注册表内厂商官方域名；**自定义网关为独立授权项**（owner 权限+审计）并强制：仅 HTTPS 443、禁 IP 字面量、DNS 解析后校验非 loopback/RFC1918/link-local/CGNAT/metadata(169.254.169.254) 段且解析与连接一致（防 rebinding）、重定向逐跳重校验、响应体积与时长上限、模型调用走独立 egress 代理且网络策略只放行该代理。key 只随通过校验的请求发送。
5. **用量与限额**：`ai_usage_daily` 计量；org 月度限额熔断；连续鉴权失败自动置 invalid 并通知。
6. **交付节奏**：安全属性（加密、verifyKey、官方白名单）随 M2 首批 AI 一步到位；厂商全矩阵、用量看板、自定义网关授权 UI 在 M5——安全不分期，广度分期。
7. 大陆可达性：SaaS 服务器侧出网调用为主；默认推荐大陆厂商；海外厂商标注可达性提示。

## 理由

自定义 base_url + 服务端携带用户 key 请求任意地址 = SSRF + key 外送双风险（二审 P0，OWASP SSRF 防护清单）；BYOK 避免平台卷入模型转售的资金与合规问题。

## 否决的备选

- 平台代付/转售 token（资金合规负担，且与"数据与成本归店主"定位冲突）。
- 前端直连厂商（key 必然暴露）。
- 无白名单的自由 base_url（draft1 方案，二审否决）。

## 后果

- egress 代理成为部署拓扑组成部分（自托管 compose 内置）。
- M0 验证项含三 adapter × 代表模型的工具调用兼容矩阵。
