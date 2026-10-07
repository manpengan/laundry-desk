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
