# Windows 功能交付与安装版验收接续（2026-10-01）

本轮用户授权完成 Windows 功能开发、编译部署及测试，随后明确云平台不再开发部署。
只使用合成数据；活动 V2 和固定本机服务继续是交付对象，根 V1 冻结。
打印机目前不可用，实体打印不记为通过。旧 Windows 工作区、数据库、备份及共享服务保留。

## 源码与独立审查

安装修复的 PR #223 已以普通 merge 合入主线 `59f13c2ccd10527c1cf21b177e1cfa05b04bf949`；依赖审计发现新 GHSA-4mh8-r7rc-xpvc 后，将活动 Server Fastify 精确升级至
5.12.5，保留原审计策略。CI 的 ACL 合成测试在原 20 秒子进程期限处被终止，仅延长测试预算至
60/90 秒，所有权限拒绝断言保留；具体冷启动阶段仍是推断；对应 head 的四项 CI 已全部通过，Windows 无源码 Runtime 二十场景通过。

新增 ADR-69 独立中文 Runtime 入口与 ADR-70 generic/hongfa 发行 profile。
C# 审查发现的源目录/文件替换竞态已改为 no-follow 同一句柄检查、哈希与持有；
TypeScript 审查发现的 profile 路径替换及打包资源重复已修复并补行为/真实配置回归。
安全、C# 与 TypeScript 独立复查通过。

后续 NSIS 实际构建发现安装说明快捷方式的美元引号被识别为变量；修正后，Windows makensis
以 `/WX` 编译实际指南宏零警告通过。Windows 2022 的严格四格矩阵确认：
中文链接名的 WSH `FullName` 回读发生变化并在 `SAVE` 返回
`System.IO.FileNotFoundException` / HRESULT `-2147024894`，等长英文名成功；
补充四项标准 OS 环境变量不改变结果。

修复使用摘要绑定的 `IShellLinkW` / `IPersistStream` helper，保持中文名称和说明，
读取旧文件使用 nofollow 同一句柄，序列化流限制 1 MiB，新文件以 `CreateNew` 创建且不覆盖冲突。
Windows 10 的中文父目录、宽字符字段回读、损坏文件、hardlink/junction、并发创建及流上限
专项共 23/23 通过，C#、安全与 TypeScript 独立审查通过；英文 Windows 2022 的新源码
入口行为与宽字符回归已通过，后续打包在精确干净源码检查处阻断，仍在收集实际工作树变化。

Counter 第二版为 `0.1.1`。打包与检查从同一包元数据取得严格版本，取消检查器固定 `0.1.0`，
macOS 检查器也统一读取包元数据，并以旧版本拒绝回归修复固定版本导致的 CI 失败，
以便验证从已安装 `0.1.0` 升级和程序回退。中文输入验收只监听真实可信 composition/input；
隔离 VM 或人工提供输入，自动填值与粘贴不计通过。已移除共享桌面的全局发键实现。

复核发现托盘仍使用单像素占位图，现改为从安装 EXE 取得图标且拒绝空图像；
菜单及双击共用最小化恢复、显示与聚焦操作。Windows 安装版测试增加五项实际窗口安全配置、
同用户第二实例退出与原窗口唤回、正常关闭重开；这些新增实机断言仍待新源码执行。

实际构建还复现 CLI 打印失败但退出码为 0；包装器在退出回调阶段保持非零退出，并以真实 CLI
子进程回归验证。升级此前没有保存新版 Programs 维护入口；Windows 回归先复现撤走候选包后
入口不存在，再以安装与升级共用原私有安装流程修复，保留旧入口。

## 当前软件验证

- 依赖审计：high=0、critical=0，仅原有两项精确例外。
- Server：1171 项，1069 通过、102 PostgreSQL 环境专项跳过、0 失败。
- Edge-agent 完整测试：110 个 scripts + 425 个 dist，共 535 通过、0 失败；
  类型检查及本次相关 lint、格式通过。
- Runtime 本地：87 项，70 通过、17 项 Windows 专属跳过、0 失败。
- Windows 10 PowerShell 5.1：生成入口行为测试 6/6 通过，环境清理、固定恢复参数、
  manifest/bootstrap/helpers/链接拒绝、安装幂等、独立目录和快捷方式、源目录撤走后继续使用，
  升级保存新版且保留旧入口，以及 Start Menu 同名文件/快捷方式同名目录冲突时不覆盖并返回稳定阶段码。
- Windows 10 ACL 合成专项：1/1 通过，约 0.4 秒。
- 失败诊断隐私回归：4/4 通过；解析、执行及未知字段失败只返回固定信封，保留原始稳定 SAVE 故障码。

Windows 专项上述入口使用受控合成 launcher，不运行真实数据库或登录任务；
SSH 令牌不等于普通用户 Session 1，不能据此关闭实机安装与 GUI 门禁。

## 安装版闭环

干净候选 `8aa3019f2f8cf47d732439b9a152f1a989fc735f` 已在独立 Windows checkout 构建：
generic/hongfa Counter `0.1.1` NSIS 及软件 inspect 均通过，两个同迁移 Runtime 开发版和独立入口生成通过。
四份产物及软件摘要已独立复核，包含入口保留、CLI 失败退出码和有限诊断修复。
该分支候选的 workspace-check、real-postgres 已通过；macOS 版本检查与 Windows 2022 快捷方式仍在修复验证。
记录为未签名分支 QA，最终 main 安装验收与发行须重新绑定合并后精确源码。

待新源码 SHA 的干净 Windows checkout 编译、打包检查及部署后补充以下独立证据：

- generic/hongfa 两个 Counter NSIS、源码/profile/helper/SPA/安装后摘要；
- 独立 Runtime 中文 GUI，普通用户 Session 1、150% DPI、无源码启停和维护；
- 真实本地服务与柜台功能旅程、备份确认恢复、第二版本升级/程序回滚的数据保留；
- OS 重启与重新登录自启、真实中文 IME composition；
- 托盘显示/恢复/退出、第二实例与正常窗口关闭；Counter 卸载重装保留本地状态；
  原生 DPAPI 离线队列在 Counter 重启后保留并恰好重放一次；
- Windows 11 标准测试环境；
- 软件打印链与打印机枚举、未签名受控开发分发记录。

暂不宣称对应 SHA CI、main、实机闭环或正式发布完成。
Windows 11、实体打印和签名状态分别以实际环境与证据更新；云生产准入已移出本轮开发部署范围。
