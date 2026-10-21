# ADR-101：Windows 全新空库的操作者初始化桥接

- 日期：2026-10-21
- 状态：**技术实现决策；本轮会话已授权实现和合成验证，待同版门禁完成**
- 实施：Codex；生产准入仍由 manpengan 签署 [ADR-98](2026-10-06-adr-98-windows-local-pilot-admission.md)
- 前序：[ADR-67](2026-08-30-adr-67-windows-native-local-runtime.md)、[ADR-69](2026-10-01-adr-69-windows-runtime-operator-entry.md)
- 范围：Windows Runtime 内部安装 action 与受信维护 GUI；不新增 HTTP/IPC Command/Query，不修改权限、计价或租户规则。

## 问题

现有 `install` 只创建随机合成管理员，并在私有 `secrets` 保留供验收 harness 使用的 bootstrap 文件。
Server 已有安全的双管理员 bootstrap，但受信 Windows 入口会清理外部环境，无法让操作者直接提交初始身份。
已有 `commission` 只补齐历史单管理员实例，不能作为已有 QA 库转正式库的开关。

宏发本轮已选择空库新装、不读取或导入 v1；打印继续暂缓。须先完成软件入口，再用合成身份验证，
不能将等待签署当作软件缺口的替代解释，也不能删除测试数据后把 QA 根当成正式实例。

## 决策

1. 保留无输入 `install` 及既有合成 harness；增加显式 `install-store`，只接收
   `{version:1, mode:"new_empty", admin, approver}`，每位管理员仅有 username、displayName、password、pin。
   不接收租户、数据库 URL、路径、角色、assurance、强制覆盖或准入参数。
2. GUI 分别设置两人的用户名、显示名、密码和 PIN；密码/PIN 遮罩并二次输入。显式确认后才调用安装；
   取消关闭并清空控件，不创建实例。密码 12–256 位，PIN 6–8 位 ASCII 数字，两人的用户名、密码、PIN 各自不同。
   服务端复用固定 payload 中的 `BootstrapInputSchema`，不复制另一套身份权限规则。私有文件传递额外拒绝换行及 NUL。
3. 受信入口使用既有 8 KiB、10 秒、有界 UTF-8 stdin 协议。个人输入不进入 argv、环境明文、
   构建物、日志、状态、诊断或公共报告。仅本次初始化把输入写入安装根下私有 `bootstrap-input`；
   写入、ACL、唯一文件与目录持久化使用现有平台 helper。
4. 安装入口在发布 Programs/快捷方式前拒绝已有根，生命周期在既有 operation lock 内再次拒绝。
   无论根是 QA、已卸载、半初始化、文件或其他未知内容，都不转换、不清空、不覆盖。端口、任务身份、
   完整发行绑定和原生预检保持既有门禁。全新 cluster 不含旧业务数据，不调用 v1/portable 导入。
5. 随机生成运行密钥；仅合成 `install` 生成持久化合成 bootstrap 凭据。新路径执行
   `roles → migrate → bootstrap → verify-commissioned`，沿用 Argon2id、事务内双管理员/元数据/审计与严格验证。
   PostgreSQL 在初始化退出时停止。一次性输入成功删除并持久化后，才记录 initialized、注册任务和启动。
6. 普通启动、升级验库和恢复读取运行密钥，不再依赖 bootstrap 输入。旧合成初始化明确传入原 `secrets` 目录。
   新路径的 bootstrap 文件在成功和普通异常下均清理；受控写入留下的 `.commit-<UUID>` 临时文件同样清理。
   进程崩溃后，下次访问已登记实例先清理残留。未知文件、链接或清理失败保持失败，不假报成功或启动。
   半初始化仍保留数据库、照片、备份和 staged 记录，使用诊断/停止处理，不自动重建。
   清理失败仍允许导出封闭元数据诊断，以固定 `setup_input_cleanup=failed` 标记并提示继续处理；
   不复制异常正文或私有输入，导出不改变服务、任务或业务状态，也不解除启动禁令。
7. 新模块与服务端 schema 文件构成可选的完整清单能力；部分新能力拒绝。Runtime manifest 格式不变。
   新空库从首个 staged 记录起使用运行状态 `schema:2`，原合成实例保持 `schema:1`；新代码读两者，不能互相转换。
   旧生命周期会在任何实例状态、服务、任务或数据库变更前拒绝 schema 2，避免在停机后才发现个人 bootstrap 文件已删除。
   schema 2 的输入发行、所选程序、服务与备份控制器都必须支持新协议，只能在支持该协议的发行之间升级与回退；
   状态保存和恢复 journal 不得改变 schema。原 schema 1 的旧版升级、回退及重装继续保留。
   旧 PowerShell 入口仍可能先发布其独立 Programs/快捷方式，不能把实例保护宣称为整机所有文件零变化。
   新 GUI helper 与其他 operator 文件一样由生成入口逐文件绑定。

## 准入界限

成功结果只含 `initialization=operator_new_empty`、`admission=pending` 和既有发行/状态字段。
所有 manifest、状态和入口仍要求 `development_only`；没有生产开关或自动放行真实数据的功能。
ADR-98 的 Proposed 状态不变。本次技术授权不代替责任人签署、受控分发政策、现场操作员与介质证据，
不授权真实短信、收费/退款或向外部模型上传真实照片。

初始个人密码/PIN 不残留在可复用明文文件中；这里指文件清理，不承诺 SSD 物理安全擦除、运行内存取证抵抗，
也不把现有持久化数据库/签名运行密钥误称已删除。私有 OS 身份与平台文件保护仍是信任边界。

## 验证和交付

- 回归覆盖实际 Server schema、身份独立性、字段/编码/长度、已有实例拒绝、合成路径兼容、成功/异常清理、
  临时文件/硬链接/未知文件、安全失败、strict verify 停库，以及恢复后启动不依赖个人输入。
- Windows PowerShell 5.1 检查遮罩、确认校验、取消清空、已有根在 Programs 发布前拒绝。
- 新固定候选须补真实 Windows 空库安装、双身份登录/复核、重启、备份/恢复、安装/升级/卸载重装及 GUI，
  不能继承修改前候选通过结果。合成数据、Server CI、winbox 与门店真人结果分别记录。
- 现场步骤与尚待签署内容见[初始化材料](../operations/windows-store-initialization-20261021/onsite.md)。
