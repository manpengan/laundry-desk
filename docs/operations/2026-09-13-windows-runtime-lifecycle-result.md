# Windows Runtime 独立安装生命周期

实现与验收入口：[PR #219](https://github.com/manpengan/laundry-desk/pull/219)。是否已交付以 `main`
与同版绿灯门禁为准；仅 `development_only` 合成数据。依据 ADR-66/67，不新增业务 Command/Query。

本批将独立 payload 接入安装、修复、启动、停止、同迁移升级/回滚和保留数据卸载。固定目录为
`%LOCALAPPDATA%\laundry-desk-v2\runtime-companion`，与旧 development-runtime 隔离。

- 发行目录、数据库、密钥和状态分离；私有根与状态文件使用既有 Win32 helper。
- 同一命名管道互斥覆盖所有生命周期动作；进程退出由内核释放，不接管陈旧 PID 锁。
- 版本指针使用临时文件、私有 ACL、文件 flush、写穿透替换、目录 flush；失败后读取磁盘状态。
- 登录任务绑定首次安装的固定 controller payload，升级只切换持久化版本指针，避免任务与指针双提交。
  controller 目录与旧版本一起保留；controller 协议自身升级需要后续专门交付。
- PowerShell 入口在执行包内 Node 前清除注入环境并校验 Node/脚本摘要；只等待直接控制进程，避免
  后台数据库延长启动入口寿命。原生 `CreateProcessW` 使用显式句柄白名单，防止后台进程继承调用方
  的隐藏管道；启动器原生代码也受分发清单摘要约束。真实迁移 ledger verify 通过后才启动服务。
- `/health` 保持现有最小信封；版本证据来自 manifest、真实迁移校验以及两个 loopback listener 的
  可执行路径、命令行和运行身份核对，不把任意 ready 响应当成版本证据。
- 同迁移升级失败恢复旧版；不同迁移摘要/迁移头直接阻断，须走备份和数据库联合恢复。
- 半初始化保留数据库与密钥并明确阻断，不自动覆盖重建。
- 候选验库前持久化 pending 记录；中断后先停止已绑定候选数据库，再恢复持久化版本。
  验库启动或收尾停机报错时，也必须确认候选进程已停止后才能清除 pending；若停机持续失败，保留
  候选身份供下一次操作重入恢复，不把仍运行的候选进程误记为旧版。
- 卸载从外部分发目录执行，先停止服务、注销已确认身份任务，再移除所有已登记版本的绑定程序；
  保留数据、密钥和恢复记录。删除中断可重入，额外或被篡改文件会阻断清理；重装首先要求与卸载记录
  相同的发行摘要。

Windows CI 在撤走源码、PATH 排除系统 Node/pnpm 后运行完整合成数据库验收，输出仅包含阶段、状态、
耗时、源码 SHA、manifest 摘要和迁移头；数据库、密钥、凭据、SQL 输出不上传 artifact。

验证命令为 `pnpm runtime:win:test` 与 `pnpm workspace:check`；Linux 上跳过的 Windows 专项须由
Windows CI 补齐。启动入口回归使用带空格路径，要求控制进程退出后管道在 1 秒内关闭，同时确认后台
测试进程仍存活；该断言排除编译冷启动耗时，也防止 `execFile` 在超时关闭管道后以旧退出码误报成功。

四项 CI 结果统一见 [PR 检查页](https://github.com/manpengan/laundry-desk/pull/219/checks)：
`workspace-check`、`runtime-app-macos`、`real-postgres`、`windows-runtime-payload`。
Windows 成功产物 `windows-runtime-development-payload` 包含完整分发包、构建记录
`runtime-build-result.json` 和逐场景记录 `runtime-lifecycle-result.json`。后者绑定实际构建源码 SHA、
manifest 摘要和迁移头；不得用另一提交或只完成加载 smoke 的记录替代。

生命周期矩阵包括端口冲突、真实数据库初始化、启停与修复、同迁移升级回滚、候选验库中断恢复、计划
任务启动、锁持有进程死亡、候选校验失败恢复旧版、迁移变化与篡改拒绝、并发互斥、指针崩溃与原生
持久化失败、服务进程中断恢复、保留数据卸载重装、任务冲突拒绝及最终卸载。重装与回滚核对合成数据
行数及密钥摘要保持一致。

目标 Windows 10/11、系统重启后的真实登录会话、中文输入、DPI、实体打印与真实数据准入仍为独立门禁。
