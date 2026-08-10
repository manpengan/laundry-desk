# AGENTS.md — laundry-desk

仓库通用 agent 入口。

## 当前 owner 与路线（ADR-37）

**Codex 为当前交付负责人**（设计、实现、集成与门禁）。详见
[ADR-37](docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)。

**仅通用 V2 是活动交付线**：宏发版本停止，根 `src/` 只保留为历史行为参考；
当前按 1–4 顺序以部署在 hk-vps 的 Cloud Web Server 作为主开发与验收形态。
Windows、macOS 正式发行、XP-58 实体验收及每个新增 Web 功能的桌面同步适配后置，
不阻塞当前 Cloud Web 功能开发。ADR-14 继续作为通用 V2 架构基线。

| 角色      | 状态                                         |
| --------- | -------------------------------------------- |
| Codex     | **Lead** — 设计、实现、集成与门禁            |
| Grok      | 退出关键路径；未合分支仅作候选输入           |
| Claude    | draft3.1a 为框架基线；当前仅作可选非阻塞复审 |
| Gemini    | 退出关键路径；未合分支仅作候选输入           |
| manpengan | 产品裁决、外部依赖、ADR 签署、最终仲裁       |

## 入场必读

1. [ADR-37：Cloud Web 主交付形态与后续 1–4 顺序](docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)
2. [ADR-14：通用 V2 本地优先架构基线](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)
3. [ADR-16：边缘运营范围追认与契约面门禁](docs/adr/2026-07-31-adr-16-edge-operations-scope-ratification.md)
   — **修订 ADR-14 §4 阶段线**，并规定新增命令/查询必须附 ADR
4. [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md)
5. [Claude V2 架构 draft3.1a](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)
6. [Claude V2 Web UI draft3.1a](docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md)
7. [ADR-13：V2-only 升级交付](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)
8. 若当前环境存在：`~/pro/kb/projects/laundry-desk/status.md`

判断"某能力是否已交付"以 `main` 代码与绿灯门禁为准，不以文档为准；发现文档滞后
按缺陷订正（ADR-16 §4）。

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
- 新增命令/查询必须在同一 PR 附 ADR；`m2-freeze.test.ts` 清单变更须在 PR 描述点名（ADR-16 §2）
- 改变对外能力边界的 PR 必须同批更新 `docs/CHANGELOG.md` 与被其推翻的验收记录（ADR-16 §4）
