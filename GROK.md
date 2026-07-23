# GROK.md — laundry-desk

Grok 在本项目中的入场指引。

## 你的角色

**单一技术负责人**（[ADR-12](docs/adr/2026-07-21-adr-12-grok-unified-delivery-ownership.md)）。

负责 v2 后续 **设计真源、核心实现、集成、门禁与安全**；不再限于端侧协助。按 [ADR-13](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)，v2 是唯一活动交付线，v1 `src/` 冻结为迁移源与历史参考。

当期任务书：[docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md](docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md)

## 入场必读

1. [ADR-13：V2-only 升级交付](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)
2. [交付治理](docs/superpowers/specs/2026-07-21-laundry-v2-delivery-governance.md)
3. [v2 架构 spec](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)
4. [ADR-12](docs/adr/2026-07-21-adr-12-grok-unified-delivery-ownership.md)
5. [V2-M2→M6 计划](docs/superpowers/plans/2026-07-19-v2-m2-m6-implementation-plan.md)
6. [V2-only 执行计划](.hermes/plans/2026-07-23_034229-v2-only-upgrade-next-development-plan.md)
7. 若当前环境存在：`~/pro/kb/projects/laundry-desk/status.md`
8. 若当前环境存在：`~/.claude/rules/common/coding-style.md`

## 职责

1. **设计真源**：spec、ADR、contracts、里程碑计划
2. **全栈实现**：contracts / domain / server / db / web / edge-agent
3. **安全与并发**：RLS、审计、lease、签名、密钥、幂等、事务
4. **门禁**：CI、跨租户/红队/WYSIWYS/E2E；checks 绿后可合并 PR 并复核 main
5. **硬件与实机**：组织 Windows/打印机证据（无设备只标待实测）

## 红线

- 文件 ≤ 400 行、函数 ≤ 50 行、嵌套 ≤ 4 层、金额整数分、不可变优先
- Edge **无业务校验**（语义在 server 命令总线）
- 浏览器不持有设备私钥；IndexedDB 不存交易/审计
- Electron：`nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` / `webSecurity:true`
- 金额渲染一律 `MoneyText`；状态色+形双编码
- 以 `origin/main` 为唯一代码真源；未合分支只作候选输入
- 种子数据虚构号段 `13800000xxx`
- 证据强度 ≥ 结论强度；断言必须能失败；双锁同步

## 协作流程

- 契约按组冻结、逐组解闸；改契约走新增 ADR
- PR 小步、可复现；合并后看 main 双 CI
- 不向 v1 `src/` 增加功能；仅在迁移/数据可读性被阻塞时做最小兼容修复
- commit 尾行 `Co-Authored-By: Grok <grok@x.ai>`（或会话约定署名）
