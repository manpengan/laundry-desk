# Windows Runtime 本机托管备份与恢复

依据 [ADR-68](../adr/2026-09-30-adr-68-windows-managed-backup-restore.md)，接续
[#219 安装生命周期](2026-09-13-windows-runtime-lifecycle-result.md)。是否交付仍以 main 与同版
绿灯门禁为准，当前仅允许 development-only 合成数据。

## 实现边界

- 经完整发行清单校验的 PowerShell launcher 提供备份、列表、验证、确认恢复与维护中断恢复；
  复用安装/升级/卸载的同一内核锁与私有存储原语。
- 当前版本和登录 controller 都必须具备备份阻断能力。旧 payload 继续可作为安装、同迁移升级和
  回滚输入；旧 controller 通过保留数据卸载及当前同一发行身份重装更新，不能手改任务权威。
- 固定私有备份目录仅包含 dump 与严格 manifest，绑定实例、发行、迁移、PostgreSQL 版本、时间、
  大小与 SHA-256，恢复要求所选 manifest 的确认摘要。拒绝路径、额外文件、链接、权限放宽与篡改。
- 维护先停止写入、保留恢复前安全点。在空临时库单事务导入后，直接执行现有 verify，不调用 migrate
  修补账本；核对关键表、照片为空与现有角色权限。候选库显式禁止 PUBLIC/应用角色 CREATE、TEMP。
- 原库与候选库名称切换在一个事务中提交，以 OID 判定丢失回执。verified 持久化前保留原库，之后
  按身份清理；原备份与恢复前安全点继续保留。
- 非 idle 维护记录阻断登录启动、普通安装/修复/启动/升级/回滚/卸载。明确重入恢复时，verified 前
  回原库，verified 后完成已验证恢复；原本停止的实例不被擅自启动。未绑定临时库保留并返回标记。
- dump 经保持打开的已验证句柄流式读写，大小、空间、进程超时、备份与临时库留存有界；原生 stderr、
  SQL 输出、连接串、凭据和数据库内容不进入产品诊断或 CI artifact。

## 验证入口

```bash
pnpm runtime:win:test
pnpm workspace:check
```

本地 Linux 的 Windows 专项跳过必须由 Windows CI 补齐。当前真实 PostgreSQL 16.15 隔离容器
回归使用完整 69 项迁移、真实 roles/bootstrap/verify，以及本片生产 dump/restore/切换实现，已验证：

1. 备份 → 改写合成计数/整数金额、增加表 → 恢复精确基线，多余新表不存在；
2. 自动安全点可恢复到维护前数据；
3. 切换生效后中断，按 OID 逆向恢复原库；
4. 原始备份账本 checksum 损坏，候选 verify 拒绝且当前数据不变；
5. OID 混淆时拒绝清理未知数据库。

Windows 无源码 CI 矩阵增加真实托管备份/恢复/安全点、文件损坏、确认/实例/版本拒绝、硬链接拒绝、
原始迁移账本损坏、切换中断恢复及 verified 后清理中断重入。其报告仍进入
`runtime-lifecycle-result.json`，与源码 SHA、发行 manifest 和迁移头绑定；备份和数据目录不上传。

## 剩余门禁

当前仅支持相同迁移与 PostgreSQL 版本、照片未启用且为空的实例。不同迁移的程序/数据库联合升级、
照片联合恢复、跨实例导入与加密外部导出尚未交付。目标 Windows 10/11 实机、登录重启、中文 IME、
DPI、三类实体打印与 ADR-65 签名/离机恢复/告警/容量/真实数据责任仍独立验收。
