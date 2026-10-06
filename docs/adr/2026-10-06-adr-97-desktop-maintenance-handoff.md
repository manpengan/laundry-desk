# ADR-97：柜台备份摘要与受控 Runtime 维护交接

- 日期：2026-10-06
- 状态：实现裁决；最终候选包的 Windows GUI 验收另行记录
- 范围：ADR-66 活动 V2 Windows 桌面、D07/U07/U08/V06 改善

## 背景

柜台只能文字提示用户打开维护程序，店长无法直接核对最近备份、离机副本、演练和下次计划。整店导出与旧版导入已有服务端一次性授权，但需要人工搬运编号。旧版照片逐张上传不适合批量迁移。此次只连接现有维护能力，不新增业务命令、任意命令执行或文件系统接口，不改变真实资料准入条件。

## 决定

增加唯一命名桌面 IPC `desktop:maintenance:operation`，输入和输出均由 Zod 严格验证：

- `health`：已登录员工可读本机摘要。返回最近成功备份、演练、离机副本、计划时间、剩余容量、核对时间与有限告警；剥离路径、完整 Runtime 配置、凭据和内部备份编号。
- `open`：仅管理员可打开 `maintenance`、`backup`、`drill` 三种固定意图。
- `handoff`：仅管理员可交接 `export-store` 或 `v1-import`，仅携带有效格式的授权 UUID；没有密码、路径或自由命令参数。

main 进程独立核对角色、会话身份、过期时间、session_version 和 permission_version，在启动前和完成后复核。复用现有发送方校验及单参数信封，不新增通用 invoke/exec。

## 安装与信任

柜台包构建时明确选择同一 source SHA 的已生成 Runtime 入口，通过 `stage-runtime-maintenance.mjs` 将 manifest 摘要、入口字节数/摘要及固定信任代码写入柜台 `dist`，随后打入 asar。构建参数为 `LAUNDRY_WINDOWS_RUNTIME_ENTRY` 和 `LAUNDRY_WINDOWS_BUILD_GIT_SHA`。没有配套绑定时禁用能力并显示不可读取，不能将未知标记健康。

运行时只派生当前用户固定安装目录 `LocalAppData/Programs/Laundry Desk Runtime V2/<绑定 manifest SHA>/runtime-entry.ps1`。柜台包中的 pin 是完整性基线，用户目录中的 manifest、release-evidence 或自身哈希不是运行时授权信任根。复用现有 Runtime C# trust policy 校验并持有目录/文件句柄，拒绝重解析点、异常文件和摘要不匹配。入口继续校验其 bootstrap、operator helper 和完整 payload。开发包仍为 `development_only`，不借此声称已满足签名或真实数据生产门禁。

数据通过受限 stdin JSON 传输；请求编号不进入 OS 命令行。维护窗口只预填此次意图与编号，仍要求原有选择/确认；原服务端授权继续负责有效期、权限、一次性消费、目标门店、事务及审计。导出目录只能在原生窗口选择；柜台不能提交路径。

## 可用性

设置增加普通员工可读的备份与恢复页，失败、过期、离机副本缺失、空间不足和计划关闭明确显示。手动备份和成功演练写入受控摘要记录；中断的维护日志产生提醒。下次计划只有已启用且任务核对成功时才给出。

旧版照片支持目录/批量选择、保留原照片与衣物编号的匹配预览、重复同名待选、缺失和格式拒绝、人工匹配及失败重试。每页最多显示 25 个目标，单批最多 5000 个文件；上传仍使用原有逐照片契约，服务端继续验证文件字节。切换草稿/会话丢弃迟回结果。

整店导出/导入授权可直接打开配套维护窗口，原生目录选择、执行状态、完成目录及校验值在该窗口显示；取消、授权过期、冲突和权限失败给出下一步。打开窗口不等于执行成功，最终结果仍以 Runtime 实际返回为准。

## 验证边界

本批包含 1000 条合成路径匹配、冲突/拒绝、按原编号重试、切换草稿、Web 未知状态、员工权限、session/permission 版本、授权重试/过期、包绑定摘要与原生命令行长度测试。Windows SSH 仅对生成入口、两个 GUI helper 和固定 bootstrap 做 PowerShell AST 解析；不将其记为已安装 Runtime GUI 完整验收。最终候选 EXE 与 Runtime 的真实交互仍需独立门禁证据。
