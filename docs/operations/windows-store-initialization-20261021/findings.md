# 已核实设计依据

- 基线 b1e24acd：lifecycle-database.mjs 自动生成 admin-win-dev / approver-win-dev；Windows operator 无现场输入入口。
- server BootstrapInputSchema 已校验两位独立管理员、12–256 字符密码与 6–8 位 PIN；bootstrap 原子写入身份、权限、配置和审计。
- kit-entrypoint 提供 bootstrap 与 verify-commissioned。commission 仅用于旧版单管理员升级，不是开发库转正式入口。
- runtimeEnvironment 原先总是读取 bootstrap 文件；新路径必须拆分一次性初始化输入与持久运行凭据，清除后仍可启动/恢复。
- 当前 manifest、状态和 UI 仅接受 development_only。技术初始化不得改变发行等级或代替 ADR-98 签署。
- 新路径固定空库、无旧数据导入；打印暂缓、Cloud 暂停。10-20 草案只读，最新范围由主代理在准入材料中整合。
