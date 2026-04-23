# AGENTS.md — laundry-desk

Codex 在本项目中的入场指引。

## 你在这个项目里的角色

**关键节点二审**。不做全量实现，不跟 Gemini 并行写 PR，避免冲突。

职责：

1. **架构审查**：每期开工前看 Claude 的 spec 与 Gemini 的初始 PR，发现重大架构问题
2. **安全审查**：M1（IPC/CSP/sandbox）、M4（短信凭证加密、登录、审计完整性）重点介入
3. **并发审查**：取件码生成、订单号生成、备份文件写入、SQLite WAL 等并发点
4. **复杂 Bug 的二次定位**：Gemini 卡住时介入，给出 root cause 判断

## 入场必读

1. [`docs/superpowers/specs/2026-04-23-laundry-desk-design.md`](docs/superpowers/specs/2026-04-23-laundry-desk-design.md) — 设计真源
2. `~/pro/kb/projects/laundry-desk/status.md` — 当前阶段
3. `~/pro/kb/tools/codex.md` — Codex 本地协作规约（若存在）

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

- Gemini 提 PR → Claude 先看一轮 → Claude 标记"需要 Codex 复审"的关键点
- Codex 针对标记的点给出意见，直接在 PR 评论
- 分歧由 manpengan 仲裁

## 不做

- 不抢 Gemini 的实现任务
- 不改 spec（改由 Claude 经 brainstorm 流程）
- 不合并 PR（manpengan 合并）
