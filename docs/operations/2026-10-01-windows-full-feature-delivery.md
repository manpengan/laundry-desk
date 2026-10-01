# Windows 功能交付与安装版验收接续（2026-10-01）

本轮用户授权完成 Windows 功能开发、编译部署及测试，随后明确云平台不再开发部署。
只使用合成数据；活动 V2 和固定本机服务继续是交付对象，根 V1 冻结。
打印机目前不可用，实体打印不记为通过。旧 Windows 工作区、数据库、备份及共享服务保留。

## 源码与独立审查

安装修复进入 PR #223；依赖审计发现新 GHSA-4mh8-r7rc-xpvc 后，将活动 Server Fastify 精确升级至
5.12.5，保留原审计策略。CI 的 ACL 合成测试在原 20 秒子进程期限处被终止，仅延长测试预算至
60/90 秒，所有权限拒绝断言保留；具体冷启动阶段仍是推断，须对应 SHA CI 再验。

新增 ADR-69 独立中文 Runtime 入口与 ADR-70 generic/hongfa 发行 profile。
C# 审查发现的源目录/文件替换竞态已改为 no-follow 同一句柄检查、哈希与持有；
TypeScript 审查发现的 profile 路径替换及打包资源重复已修复并补行为/真实配置回归。
安全、C# 与 TypeScript 独立复查通过。

## 当前软件验证

- 依赖审计：high=0、critical=0，仅原有两项精确例外。
- Server：1171 项，1069 通过、102 PostgreSQL 环境专项跳过、0 失败。
- Edge-agent 完整测试：106 个 scripts + 425 个 dist，共 531 通过、0 失败；
  类型检查及本次相关 lint、格式通过。
- Runtime 本地：72 项，64 通过、8 项 Windows 专属跳过、0 失败。
- Windows 10 PowerShell 5.1：生成入口 8/8 通过，环境清理、固定恢复参数、
  manifest/bootstrap/helpers/链接拒绝、安装幂等、独立目录和快捷方式、源目录撤走后继续使用。
- Windows 10 ACL 合成专项：1/1 通过，约 0.4 秒。

Windows 专项上述入口使用受控合成 launcher，不运行真实数据库或登录任务；
SSH 令牌不等于普通用户 Session 1，不能据此关闭实机安装与 GUI 门禁。

## 安装版闭环

待新源码 SHA 的干净 Windows checkout 编译、打包检查及部署后补充以下独立证据：

- generic/hongfa 两个 Counter NSIS、源码/profile/helper/SPA/安装后摘要；
- 独立 Runtime 中文 GUI，普通用户 Session 1、150% DPI、无源码启停和维护；
- 真实本地服务与柜台功能旅程、备份确认恢复、第二版本升级/程序回滚的数据保留；
- OS 重启与重新登录自启、真实中文 IME composition；
- Windows 11 标准测试环境；
- 软件打印链与打印机枚举、未签名受控开发分发记录。

暂不宣称对应 SHA CI、main、实机闭环或正式发布完成。
Windows 11、实体打印和签名状态分别以实际环境与证据更新；云生产准入已移出本轮开发部署范围。
