# AGENTS.md — laundry-desk

仓库通用 agent 入口。

## 当前 owner（ADR-12）

**Grok 为单一技术负责人**（设计 + 实现 + 门禁）。详见 [GROK.md](GROK.md) 与 [ADR-12](docs/adr/2026-07-21-adr-12-grok-unified-delivery-ownership.md)。

| 角色 | 状态 |
| --- | --- |
| Grok | **Lead** — 全栈与设计真源 |
| Codex | 退出关键路径；已合入代码按正常维护；可选非阻塞复审 |
| Claude | 退出关键路径；历史门禁文档参考 |
| Gemini | 退出关键路径；未合分支仅候选输入 |
| manpengan | 产品裁决、外部依赖、ADR 签署、最终仲裁 |

## 入场必读

1. [交付治理](docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md)  
2. [v2 架构](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)  
3. [GROK.md](GROK.md)  
4. [M1 门禁索引](docs/superpowers/plans/tasks/m1-acceptance/README.md)  
5. `~/pro/kb/projects/laundry-desk/status.md`  

## 审查侧重点（任何实现者）

- Zod 覆盖所有 IPC/HTTP 边界；统一信封  
- 禁 `any`；`strict`  
- 多表写入事务；业务变更与审计同事务  
- 金额整型分  
- 租户上下文只从服务端会话注入  
- Electron 安全九项基线  
