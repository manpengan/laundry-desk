# GROK.md — laundry-desk

Grok 在本项目中的入场指引。

## 你的角色

[ADR-66](docs/adr/2026-08-29-adr-66-windows-hongfa-pilot.md) 已将 Windows V2 定制 EXE 与宏发受控
试点确定为当前路线，ADR-14 通用 V2 架构和 ADR-65 真实数据准入继续有效。Codex 是当前交付负责人；Grok 退出关键
路径，可提供非阻塞复审或候选输入，但不拥有当前 spec、实现、门禁或合并权。

历史任务书
[2026-07-21-task-grok-lead.md](docs/superpowers/plans/tasks/2026-07-21-task-grok-lead.md)
不再是当前执行入口。

## 入场必读

1. [ADR-66：Windows V2 与宏发试点](docs/adr/2026-08-29-adr-66-windows-hongfa-pilot.md)
2. [Windows 实机 findings](docs/research/2026-08-29-windows-port-findings-and-build-host.md)
3. [ADR-37：Cloud Web 主形态](docs/adr/2026-08-10-adr-37-cloud-web-primary-delivery.md)
4. [ADR-14：通用 V2 架构基线](docs/adr/2026-07-25-adr-14-generic-local-first-v2-delivery.md)
5. [本地优先产品设计](docs/superpowers/specs/2026-07-25-local-first-v2-product-design.md)
6. [Claude V2 架构 spec](docs/superpowers/specs/2026-07-19-laundry-v2-architecture.md)
7. [Claude V2 Web UI spec](docs/superpowers/specs/2026-07-19-laundry-v2-web-ui-design.md)
8. [ADR-13：V2-only 升级交付](docs/adr/2026-07-23-adr-13-v2-only-upgrade-delivery.md)
9. [AGENTS.md](AGENTS.md)

## 可选复审范围

- contracts / domain / server / db / web / edge-agent 的非阻塞复审；
- 安全、并发、RLS、审计、幂等和事务风险提示；
- 未合分支中的可复用候选输入说明。

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

- 不直接实施或合并，除非 manpengan 另行明确授权；
- 候选建议必须对照 ADR-66、ADR-65、ADR-14 与当前设计基线；
- 不向 v1 `src/` 增加功能；宏发只允许作为通用 V2 的发行 profile、迁移与试点对象。
