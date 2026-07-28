# AGENTS.md — laundry-desk

仓库通用 agent 入口。

## 当前 owner 与路线（ADR-14）

**Codex 为当前交付负责人**（设计、实现、集成与门禁）。详见
[ADR-14](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)。

**仅通用 V2 是活动交付线**：宏发版本停止，根 `src/` 只保留为历史行为参考；
当前优先交付本地 Web Server 与 macOS App，云部署和 Windows 适配后置。

| 角色      | 状态                                         |
| --------- | -------------------------------------------- |
| Codex     | **Lead** — 设计、实现、集成与门禁            |
| Grok      | 退出关键路径；未合分支仅作候选输入           |
| Claude    | draft3.1a 为框架基线；当前仅作可选非阻塞复审 |
| Gemini    | 退出关键路径；未合分支仅作候选输入           |
| manpengan | 产品裁决、外部依赖、ADR 签署、最终仲裁       |

## 入场必读

1. [ADR-14：通用 V2 本地优先交付](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)
2. [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md)
3. [Claude V2 架构 draft3.1a](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)
4. [Claude V2 Web UI draft3.1a](docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md)
5. [ADR-13：V2-only 升级交付](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)
6. 若当前环境存在：`~/pro/kb/projects/laundry-desk/status.md`

## 活动 V2 文件规模政策

- 活动 V2 生产 JS/TS 文件默认 400 physical lines；后续触及该默认值时，应拆分职责或缩小变更范围。
- 测试文件 800 physical lines 为硬上限；后续触及该上限前必须拆分。
- 规格列出的 15 个命名冻结预算不得增长；后续触及时，应拆分文件或缩小变更范围。

详见[文件规模质量门禁设计](docs/superpowers/specs/2026-07-27-file-size-quality-gate-design.md)。

## 审查侧重点（任何实现者）

- Zod 覆盖所有 IPC/HTTP 边界；统一信封
- 禁 `any`；`strict`
- 多表写入事务；业务变更与审计同事务
- 金额整型分
- 租户上下文只从服务端会话注入
- Electron 安全九项基线
