# 工作区与 GitHub 主线核对 · 2026-10-10

本轮范围：检查工作区未提交/未推送版本，更新 GitHub 主线，保留独有工作后删除用户列出的 23 个分支及其同名 GitHub 分支。没有操作 Gitea、删除测试产物、重新发布应用或复跑 Windows 验收。

## 核对输入

- GitHub `main`：`c815bc7fab04fa3772379c14ff2ca694c0335e18`，PR #246 普通合并后的版本。
- 该 SHA 的 [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37881642118)、[真实 PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37881642078)、[Windows Counter](https://github.com/manpengan/laundry-desk/actions/runs/37881642157)、[Windows Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37881642172) 四个 workflow 均成功。
- 4 个实际存在的 worktree 中，3 个有未提交改动，共 11 个 tracked 文件；另有 2 个路径已不存在的旧 worktree 注册。
- 独有未推送提交为 `claude/pilot-acceptance-20261008` 的 `d31fdde3`，只新增文档。原 `backup/codex-wip-20260908` 指向既有 stash，不作为待交付实现。

## 工作区改动处置

| 工作区                                    | 核对结果                                                                                           | 处置                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 主目录 `laundry-desk`                     | 4 个文档改动；`progress.md`、`task_plan.md` 与最新主线逐字相同，其余两份内容已包含且主线有更新章节 | 保留原文件备份，使用最新主线文件                                                     |
| `ui-ux-remediation-20261005/laundry-desk` | 6 份未提交的发行记录                                                                               | 三方合入，保留主线新增的决策工作表与走查清单；明确历史截止时间和后续验收结果         |
| `.claude/worktrees/pr229-remediation`     | 1 个未提交文档与 `d31fdde3`                                                                        | 普通合入提交，并补齐未提交的 `5587b003` 复验记录；失败、未执行与诊断分项不计完整通过 |
| `laundry-desk-wt-ui`                      | clean detached HEAD，恰为输入 `c815bc7f`                                                           | 用于本次记录整合；整合分支合并后清理                                                 |

全部 Git 引用与 11 个原始 tracked 文件已备份到仓库外 `laundry-desk-archive/branch-cleanup-20261010-159ae1c0`：包含已验证的 `all-refs.bundle`、逐工作区 binary patch、原始文件与 SHA-256 清单。原 worktree 的 `output/`、Playwright 证据、生成 SPA 目录和既有 stash 保留。

## 用户指定分支的处置依据

| 分支                                       | 核对时 SHA | 主线与独有内容                                                                     |
| ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------- |
| `backup/codex-wip-20260908`                | `6e3cc5da` | 旧 stash 快照；已由 PR #216/#218/#219 接续，保留 stash 和外部 bundle，不重放旧实现 |
| `claude/deps-audit-20261006`               | `c4ed9620` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/desktop-login-username-only`       | `aa380157` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/maintenance-localappdata`          | `5587b003` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/maintenance-port-fix`              | `3fc77edf` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/pilot-acceptance-20261008`         | `d31fdde3` | 独有 `d31fdde3` 及工作区后续记录纳入本次普通合并                                   |
| `claude/pilot-readiness-20261008`          | `a67f57bc` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/pr229-remediation`                 | `d22f8ef0` | `d22f8ef0` 与主线 `c9be160b` 补丁等价；`git cherry` 为 `-`                         |
| `claude/pr233-takeover`                    | `9a472271` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/receive-qr-prepay`                 | `7f844f66` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/stats-income-permission`           | `5b585655` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `claude/ui-themes-liquid-glass`            | `38609d9e` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/photo-viewer-viewport-20261008`     | `9719af1b` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/ui-ux-remediation-20261005`         | `ae137413` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-acceptance-record-20261007` | `1462e242` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-final-acceptance-20261008`  | `c5eeb80d` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-full-features-20261003`     | `dacc01b0` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-photo-render-20261008`      | `990c7c74` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-pickup-latency-20261008`    | `713efb69` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-release-closure-20261007`   | `2911c6b6` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-release-closure-20261008`   | `fad33482` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-rollback-compat-20261007`   | `939db9bc` | 已在 `c815bc7f` 历史中；无独有提交                                                 |
| `codex/windows-settings-loading-20261007`  | `7248c79f` | 已在 `c815bc7f` 历史中；无独有提交                                                 |

`codex/ui-ux-remediation-20261005` 的 GitHub 头 `9a472271` 比本地 `ae137413` 更新，但两者都已在主线。分支删除前重新核对远端头与主线关系；工作区原始文件摘要与备份相符后才切换或恢复。

GitHub 另有未在用户清单中的 `codex/fix-october-review-1-6-7`（核对时 `9585de2f`，主线之外 1 个提交），保留待独立审查，未混入本次文档整合，也不删除。

## 验收边界

补交记录中最新 Windows 候选为 `5587b003` / Runtime `0.1.19`，完整主流程尚未通过；维护刷新与打开窗口仅在诊断中通过，窗口就绪仍失败。此前 `5db094aa` 的 D04 2/2 和 `9719af1b` 的照片分项保持各自来源。`c815bc7f` 的 CI 绿灯不能替代新登录版本的目标机完整验收。

本次提交、PR 门禁、普通合并以及工作区更新的实际终态以 GitHub 与外部清理回执为准。本文件提供清理输入和每个分支的判断依据，不预先宣称清理已完成。
