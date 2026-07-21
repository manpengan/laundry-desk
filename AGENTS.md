# AGENTS.md — laundry-desk

Codex 在本项目中的入场指引。

## 你在这个项目里的角色

**单一技术负责人**。自 ADR-10（2026-07-21）起，Codex 负责 laundry-desk v2 后续设计、核心实现、集成、门禁与安全复审；Grok 在冻结接口下协助端侧、平台、硬件与黑盒测试。

职责：

1. **设计真源**：维护架构 spec、ADR、contracts 与里程碑实施计划
2. **核心实现**：负责 contracts/domain/server/PG/migrations/identity/Policy/迁移工具
3. **安全与并发**：负责 RLS、审计、lease、签名、密钥、幂等、事务和恢复语义
4. **集成门禁**：验证并在授权范围内合并 PR，复核 main CI、跨租户/红队/WYSIWYS/E2E 与实跑证据
5. **协助线管理**：先冻结 ports/contracts，再由 Grok 实现 Web/UI、平台 adapters 和硬件验证

## 入场必读

1. [`docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md`](docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md) — 当前交付治理
2. [`docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md`](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md) — v2 架构真源
3. [`docs/adr/2026-07-21-adr-10-single-owner-delivery-governance.md`](docs/adr/2026-07-21-adr-10-single-owner-delivery-governance.md) — owner 裁决
4. [`docs/superpowers/plans/tasks/2026-07-21-task-codex-lead.md`](docs/superpowers/plans/tasks/2026-07-21-task-codex-lead.md) — 当前任务书
5. `~/pro/kb/projects/laundry-desk/status.md` — 当前阶段
6. `~/pro/kb/tools/codex.md` — Codex 本地协作规约（若存在）

## 审查侧重点

### 通用

- **输入验证边界**：Zod schema 是否覆盖所有 IPC / 服务入口
- **类型安全**：禁 `any`、禁不必要的 `as`、严守 `strict`
- **事务**：多表写入（收件 / 取件 / 备份元数据更新）必须事务
- **金额精度**：整型分、零浮点、汇总与明细一致性

### M1（基础）

- Electron 安全：`contextIsolation` / `sandbox` / `nodeIntegration` / CSP / preload 暴露面最小
- DB 初始化 & migration 的幂等性
- 取件码 / 订单号生成的并发安全（单实例进程内也要事务重试）
- 备份 → zip → rotate 链路的原子性与失败回滚

### M2（收款 & 统计）

- 金额浮点陷阱（展示时再除 100）
- 聚合查询性能（大表上的 `GROUP BY receive_date`）
- Excel 导入的数据清洗与主键冲突处理

### M3（照片 & 打印）

- 大文件（照片）的磁盘占用与清理策略
- 打印驱动抽象是否真能支持换型号
- 打印失败是否阻塞业务流程（必须异步 / 可重试）

### M4（员工 & SMS）

- Argon2 参数（memory / time / parallelism）对 Windows 柜台 CPU 的影响
- 会话机制（login 后怎么保持？Electron 单用户场景）
- **短信 SecretKey 加密存储**：必须用 OS keychain（`keytar`），不入库明文
- 审计日志完整性（所有写入是否都走审计）

## 流程

- Codex 冻结设计/contracts/ports → Codex 核心实现或 Grok 受约束适配 → 独立测试 → PR CI → Codex 按书面授权合并 → Codex 验证 main
- Claude/Gemini 的未合分支只作候选输入；可选复审不得阻塞关键路径
- 分歧由 manpengan 仲裁

## 不做

- 不在主 checkout 编辑，不直接推 main
- 不把 spike/mock/远端分支写成生产完成
- 不让 Grok 自行改变 canonicalization、密钥、租户、lease、审计或审批语义
- 不绕过 required checks、独立验收或 main 合入后复核
