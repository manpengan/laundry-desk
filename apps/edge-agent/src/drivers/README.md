# Edge drivers（Grok 协助线）

**范围**：纯渲染 / 平台 I/O adapters。  
**禁止**：自行设计 job/receipt schema、签名模板不变量、配对/lease 状态机——等 Codex ports。

| 目录                | 状态                                                              |
| ------------------- | ----------------------------------------------------------------- |
| `render/`           | 金额 GBK ￥、CODE128 宽度估算（自 M0-3 迁入）                     |
| `../print/`         | D4：template-render + escpos-xp58 + print_jobs + executor（mock） |
| OS 凭据 / SQLCipher | D2 端口已就位；D3 SQLCipher 骨架并行中                            |
