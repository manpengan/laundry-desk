# 进度

## 2026-10-07 入场

- 用户明确授权完成剩余工作、提交推送及合并所有 PR。
- GitHub main 已从上次状态 `560cb37c` 更新到 `4ba4db4d`，新增 PR #236 六套配色与分级动效。
- `gh pr list --state open` 返回空列表；不需要处理遗留开放 PR。
- 既有隔离 worktree tracked clean，fetch 后从 origin/main 建立本轮分支；原目录四个修改文件及生成物未动。
- Windows agent 正核对当前安装、8787 进程归属与交互会话；CI agent 正核对最新 main 门禁与可复用发行产物；explorer 正查安全升级与验收工具。

## 跨 schema 升级默认备份修复

- `UPGRADE_REQUIRED` 是对不同迁移的发行执行 install/repair 导致的预期拒绝；必须使用可信入口的 upgrade 动作，不能直接改状态。
- 发现实际缺陷：跨 schema 升级和已提交升级的维护恢复提前返回，跳过 ADR-91 的默认备份初始化。只对完成后运行中的成功升级补初始化，保留显式关闭、停止状态及回滚行为。
- 新增回归在旧实现上 3 项失败；修复后定向 31/31 通过。Runtime 全套本地 200 项：172 通过、28 平台/环境条件跳过；定向 lint/格式通过，独立 TypeScript 审查无 P1/P2 阻断。
- 原生无源码测试增加“旧版从未配置备份”的条件及每日 03:00 断言；Windows 结果尚未取得。
- 真实 8787 服务来自旧开发目录（HEAD `d3d04598`，134 项 tracked 改动）；原目录不改。已有默认 Companion 与当前服务不能混称同一安装。
- 既有向日葵服务指向不存在的 OldAweSun.exe，单次启动失败后仍为 Stopped/Manual，配置未变。已请求用户恢复可视远控，SSH 验收继续。

## 候选、验收入口与 PR

- 产品候选 `9b242a8a7c92d33ededc0c6f08159a4f400715ba` 已提交推送。Windows 在独立目录 `C:/dev/ld-release-20261007/repo` 干净构建；2026-10-07 18:33（台北）由普通权限 Session 1 启动，计划 Runtime 为 `0.1.11-win-dev.20261007`。构建开始不代表安装或验收通过。
- `386cef549e45238f5bdf5ec6da9e0c68e894e079` 仅修改功能验收：强制预期产品 SHA/profile，校验实际安装的 EXE、ASAR、SPA、helper 和来源记录，独立记录测试 runner 与编译后检查器摘要，拒绝运行中变更和旧结果覆盖。
- 完整旅程、诊断及清理均成功后才发布最终通过记录；独立安全审查发现的提前发布问题已修复。13/13 证据回归、edge-agent 类型检查及定向 lint/格式/语法检查通过。
- `2da506b48be074264c885abfeb01e8035d180381` 仅更新旧验收清单；双 profile 功能 runner 使用该提交，与产品来源分别记录。上述三项提交均已推送。
- [PR #237](https://github.com/manpengan/laundry-desk/pull/237) 已创建，18:38 启动该 HEAD 的 [Foundation](https://github.com/manpengan/laundry-desk/actions/runs/37608740068)、[PostgreSQL](https://github.com/manpengan/laundry-desk/actions/runs/37608740018)、[Counter](https://github.com/manpengan/laundry-desk/actions/runs/37608740089)、[Runtime](https://github.com/manpengan/laundry-desk/actions/runs/37608740158) 门禁，当前尚未取得最终结论。
- Windows 11 历史宿主的 Tailscale 连接在 18:40 复核仍使用 IPv4 直连，未满足 Linux SSH 技能的 IPv6 条件；未打开 SSH。已向用户请求本轮路径例外，等待答复。现有 Windows 10 工作继续。
- 后续 CI 配置将 13 项安装来源/证据回归加入 Windows Counter generic 原生步骤；Foundation 的 `scripts/*.test.mjs` 已包含该测试。此提交不改变产品或 functional runner，最终合并以新 HEAD 的门禁结果为准。
