# ADR-75：Windows 本机 AI 运行与 BYOK 配置

- 日期：2026-10-03
- 状态：实现中，待 Windows 原生验收
- 范围：ADR-66 Windows V2；Cloud 按 ADR-71 保持暂停

## 问题

已有 provider adapter、BYOK envelope、凭据复核/验证、只读工具、预算和熔断，但正常本机启动没有
注入真实 KMS/provider，Electron 也没有 AI 能力入口。仅测试注入通过不代表 Windows 可以使用 AI。

## 裁决

Windows PostgreSQL loopback 服务使用当前 Windows 运行账户的 DPAPI 托管每条凭据的随机 DEK。
API key 继续以现有 AES-256-GCM envelope 保存到 PostgreSQL，AAD 和 DPAPI entropy 均绑定组织、
服务商、凭据 ID 和 envelope 版本。没有软件内置主密钥、明文文件或 renderer 密钥读取接口。
启动以随机挑战验证 protect/unprotect；失败明确记录固定错误并禁用 AI，基础业务仍可运行。

原生桥固定为 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`，校验路径非 reparse、
系统 owner 和写入 ACL；仅使用静态脚本、清洁子进程环境、`NoProfile`，秘密走有界 binary stdin。
15 秒期限、完整进程关闭、零退出码、输出魔数与长度均须通过；错误不包含秘密或原生 stderr。
DEK 和临时 Buffer 在完成与失败路径清零。密文由既有数据库 RLS 与 Runtime 私有数据库目录保护。

CurrentUser 的恢复边界是 Windows 用户身份和 DPAPI profile。迁移到其他电脑/账户不能承诺原密钥
可恢复，需重新录入并验证服务商密钥。普通数据库备份不导出可移植明文或软件 KEK。

## 配置与授权边界

新增固定 HTTP `GET/POST /api/v2/ai/runtime-config`，只允许当前组织店长且具备 `ai_key_manage`。
POST 使用 CSRF、限流、strict schema、版本 CAS，并再次验证当前登录/人员/角色权威。
这是 R3 管理设置操作：界面完整展示服务商、模型、启用状态、月预算和单价，点击明确的联网保存按钮。
密钥替换/轮换/撤销仍走已有 R5 pending + 另一店长现场 PIN 复核，不降低原策略。

配置扩展现有 `ai_safety_policies`，不向 `laundry_app` 开放原表写入；安全定义函数校验当前组织/
会话/管理员。配置和预算同事务更新，版本与 before/after 审计同时写入。沿用组织预算锁避免配置
更新与预算预留竞态。没有客户端指定租户或任意 base URL。

只允许既有 DeepSeek、Anthropic、Gemini adapter 的固定 HTTPS host。启用时使用 active credential
对服务商模型目录作有界验证；模型 ID 由管理员输入并实际发现，不把测试 registry 或猜测价格写成
产品默认值。管理员填写相同账单币种的整数 micros 单价/月预算；这是本地估算而非服务商计费保证。

每个请求按服务器租户上下文解析当前配置和 active credential；每次 provider 调用前复核配置版本，
再租用、解密并使用当前版本密钥，完成后清零。配置变化、撤销、预算耗尽和熔断均失败关闭，不切换
到 fake provider。只读工具、PII 脱敏、prompt injection、输出限额和审计继续采用现有实现。

Electron 增加有固定判别 schema 的 `desktop:ai:operation` 能力。renderer 只能选择有限 AI 业务
操作，不能指定 URL、method、header、token 或 cookie。主进程持有登录凭据，验证输入/输出、固定
loopback 路径和会话代际；注销/切换人员取消在途流。离线和恢复只读模式不开放 AI 联网操作。
目前桌面 IPC 接收有界 SSE 完整结果后逐事件交给 UI；HTTP 层保持 SSE 和服务端取消/重放语义。

## 验证与限制

回归覆盖 envelope 身份绑定、Buffer 清零、错误脱敏、配置版本漂移、跨组织隔离、撤销后停止出网、
桌面固定操作/CSRF/秘密响应拒绝、注销取消和过时结果隔离，并保留既有预算/熔断/只读工具测试。
原生测试仅在 Windows 执行，非 Windows 明确 skip。真实服务商调用还需用户在产品界面配置自己的
API key；无密钥时不得把合成 adapter 回归写成已完成外部调用验收。

参考：[Microsoft ProtectedData / DPAPI](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=netframework-4.8)、
[Windows PowerShell 启动参数](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)。
