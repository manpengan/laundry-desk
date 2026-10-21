# 进度

- 集成补充：一次性输入清理失败仍可导出固定状态的诊断；操作者新空库使用 schema 2，拒绝旧控制器并保持升级、回退与恢复状态版本。两轮独立 TypeScript/安全复核通过。真实 b1 控制器对新安装四阶段、六类操作共 24 组合均在实例变更前拒绝；该实证为兼容检查，不代替 Windows 实机。
- 最终本机完整 Runtime 回归：247 项，216 passed、31 Windows/真实 PG skipped、0 failed；Runtime ESLint、Prettier、diff 检查通过。文件规模及 Windows 脚本门禁 8/8 通过。真实 PG CI helper 的独立 TypeScript/安全复核均已通过；待提交和新候选 Windows 实测。

- 2026-10-21：完成只读源码与 ADR 差距核对。交付负责人授权最小桥接实现和合成回归；当前固定候选实机结果只作为基线，产品变更后须建立新候选。
- 2026-10-21：开始受限输入、全新实例约束、一次性凭据清理和普通用户 GUI 实现。尚未运行新逻辑或 Windows 验收。
- 2026-10-21：技术实现完成并冻结，供独立安全与 TypeScript 复核。只修改 managed worktree；未连接 Windows、未提交/推送/合并，未修改 wt-ui 草案。
- 首次全量测试暴露旧 `lifecycle-recovery` 动态注入夹具未提供新依赖（8 项 ReferenceError）；补齐夹具真实 guard，增加既有根拒绝与清理失败仍可受控停止回归。复跑 10/10 通过；未放宽产品门禁。
- `pnpm runtime:win:test`：225 项，194 passed、31 skipped、0 failed。31 项因 Windows 或真实 PostgreSQL 环境条件跳过；包括本次新增 3 项 Windows 输入/遮罩/取消检查，不能记为实机已通过。
- `pnpm exec eslint tools/windows-runtime --ext .mjs --max-warnings=0`、`pnpm exec prettier --check tools/windows-runtime/*.mjs tools/windows-runtime/README.md`、`git diff --check` 通过。
- `pnpm exec turbo run build --filter=@laundry/server`：5 个构建任务成功（缓存）；随后 `pnpm --filter @laundry/server typecheck` 和 `pnpm --filter @laundry/server build` 实际重新执行 tsc 通过。
- `node --test apps/server/dist/local/bootstrap.test.js apps/server/dist/local/bootstrap-cli.test.js apps/server/dist/local/bootstrap-readiness.test.js apps/server/dist/local/secret-file.test.js`：60 项，59 passed、1 真实 PostgreSQL 项 skipped、0 failed。
- 新候选尚未固定；以上均为软件回归，不继承修改前 b1e24acd 候选的 Windows 通过结果，不改变 development_only/ADR-98 Proposed。

## 接续验证入口

1. 先构建 Server，再执行 `node --test tools/windows-runtime/store-initialization.test.mjs tools/windows-runtime/lifecycle-recovery.test.mjs`，确保实际打包同源 schema 被读取；尚未构建 Server 的环境会明确跳过 schema 单项。
2. Windows PowerShell 5.1：`node --test tools/windows-runtime/runtime-entry-store-windows.test.mjs tools/windows-runtime/runtime-entry-windows.test.mjs tools/windows-runtime/runtime-entry-input-windows.test.mjs`。
3. 同源新 Counter/Runtime 固定后，在隔离且未有 root 的 Windows 验证受信 `install-store` 的真实 roles/migrate/bootstrap/verify-commissioned、双账号登录/复核、重启与后续备份/恢复；个人输入只写 stdin，不把它加入 argv 或公开报告。
4. GUI 实际取消与遮罩、已有 root 拒绝且 Programs/快捷方式不变、严格验证失败/清理失败无假成功、成功及失败后一次性输入检查；中断残留只在原根保留处理，不通过删除 QA 库重跑。
5. 再跑原安装/升级/回退/卸载保留状态与成套 Counter 全量验收。独立审核、Windows 原始输出、最终 CI 与准入签署分别归档。

## Windows CI 初始化验收接入（2026-10-21）

- 新增 CI 专用 `store-initialization-acceptance.mjs`，随现有 lifecycle harness 复制到仓库外执行，不进入发行 payload。必须由候选 manifest 声明完整初始化 capability；旧候选或部分 capability 明确失败。
- 原 25 个场景的断言保留；成功建库场景改用 `install-store`，新增既有根拒绝场景，总计 26 个。端口冲突与原生版本失败仍使用原 `install`，后续停止、启动、修复、备份、恢复、升级、回退、卸载重装仍执行原链。
- 随机合成的双管理员用户名、显示名、密码、PIN 仅在内存生成，经 stdin 传入。真实 payload/PostgreSQL 验收检查两组 Argon2id 密码和 PIN、独立且启用的 admin/privacy 角色、两次 loopback HTTP 登录及 `verify-commissioned`；结果必须为 `operator_new_empty`、`admission: pending`、`development_only`。
- 验收检查一次性目录与 8 个 bootstrap 文件均不存在、正常环境无 bootstrap 引用、日志无输入值。既有根拒绝后要求 state、秘密文件集合及内容摘要、原 SQL 探针保持；从成功初始化开始，后续每个场景要求 `state.schema === 2` 且输入文件没有重建，覆盖备份、恢复、升级、回退、卸载重装；fresh 两个失败场景不要求已有 state。公开输出仅保留固定错误码与重建的耗时字段，不发布原始异常、stdout/stderr 或账号输入。
- 直接回归命令：`node --test tools/windows-runtime/lifecycle-acceptance-command.test.mjs tools/windows-runtime/store-initialization-acceptance.test.mjs tools/windows-runtime/backup-acceptance-fixture.test.mjs tools/windows-runtime/maintenance-acceptance.test.mjs`：20 项，19 passed、1 真实 PostgreSQL 项 skipped、0 failed。
- 安全与兼容回归命令：`node --test tools/windows-runtime/store-initialization.test.mjs tools/windows-runtime/runtime-entry-store-windows.test.mjs tools/windows-runtime/runtime-entry-input-windows.test.mjs tools/windows-runtime/runtime-entry.test.mjs tools/windows-runtime/lifecycle-task-security.test.mjs tools/windows-runtime/upgrade-photo-environment.test.mjs`：34 项，26 passed、8 Windows 项 skipped、0 failed。
- 本批验收文件的 ESLint、Prettier，以及 `pnpm --filter @laundry/server typecheck` 通过。旧 controller/state 的 schema 2 兼容门禁与 CI helper 均已完成独立 TypeScript/安全复核；本批未运行新候选 Windows，不能据此宣布产品或真实业务准入已完成。
- 真正 Windows 入口仍为 workflow 的仓库外 `node lifecycle-acceptance.mjs <payload> <manifest-sha256> <report-file>`，使用 payload 自带 Node 和 PostgreSQL。新候选必须重跑完整链并得到 26 项通过；旧 b1 实机结果不能替代。普通用户 GUI 遮罩、取消、受信 entry 及旧 `install` 的独立实机验证仍按上文接续入口执行。
