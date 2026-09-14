# Windows Runtime 独立安装生命周期

状态：实现与验证进行中；仅 `development_only` 合成数据。依据 ADR-66/67，不新增业务 Command/Query。

本批将独立 payload 接入安装、修复、启动、停止、同迁移升级/回滚和保留数据卸载。固定目录为
`%LOCALAPPDATA%\laundry-desk-v2\runtime-companion`，与旧 development-runtime 隔离。

- 发行目录、数据库、密钥和状态分离；私有根与状态文件使用既有 Win32 helper。
- 同一命名管道互斥覆盖所有生命周期动作；进程退出由内核释放，不接管陈旧 PID 锁。
- 版本指针使用临时文件、私有 ACL、文件 flush、写穿透替换、目录 flush；失败后读取磁盘状态。
- 登录任务绑定首次安装的固定 controller payload，升级只切换持久化版本指针，避免任务与指针双提交。
  controller 目录与旧版本一起保留；controller 协议自身升级需要后续专门交付。
- 启动使用包内 Node，清除未知 Node/PG/LAUNDRY 环境；真实迁移 ledger verify 通过后才启动服务。
- `/health` 保持现有最小信封；版本证据来自 manifest、真实迁移校验以及两个 loopback listener 的
  可执行路径、命令行和运行身份核对，不把任意 ready 响应当成版本证据。
- 同迁移升级失败恢复旧版；不同迁移摘要/迁移头直接阻断，须走备份和数据库联合恢复。
- 半初始化保留数据库与密钥并明确阻断，不自动覆盖重建。
- 卸载从外部分发目录执行，先停止服务、注销已确认身份任务，再移除已绑定程序；保留数据、密钥和
  恢复记录。重装首先要求与卸载记录相同的发行摘要。

Windows CI 在撤走源码、PATH 排除系统 Node/pnpm 后运行完整合成数据库验收，输出仅包含阶段、状态、
耗时、源码 SHA、manifest 摘要和迁移头；数据库、密钥、凭据、SQL 输出不上传 artifact。

目标 Windows 10/11、系统重启后的真实登录会话、中文输入、DPI、实体打印与真实数据准入仍为独立门禁。
