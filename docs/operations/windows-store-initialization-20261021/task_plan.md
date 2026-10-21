# Windows 空库初始化桥接

范围：新增受信 `install-store` 操作，现场输入两位独立管理员；仅新实例，保留旧 `install` 合成流程。不连接 Windows、不修改其他 worktree、不提交推送。发行仍为 development_only；ADR-98 签署与真实业务开放独立。

1. 设计与源码定位：完成。复用 BootstrapInputSchema、Argon2id、事务审计和 verify-commissioned；凭据不进入 argv/日志/候选包。
2. 实现：完成并冻结。受限 stdin → 私有一次性文件 → 原初始化事务 → 严格验证 → 清除个人凭据 → 启动。已有 root 拒绝；失败保留数据库与恢复状态。
3. 本机回归：完成。有效输入、字段/独立身份、既有实例、异常清理、秘密不回显、失败不启动；生成入口与文件绑定。Windows 遮罩/确认/取消原生用例已编写，当前 Mac 跳过，尚未计为通过。
4. 文档与本机验证：完成。ADR-101、初始化说明、CHANGELOG、旧限制手册同步；直接 node tests、lint、格式、Server typecheck/build 通过。独立审查与 Windows 全量新候选验收待交付负责人接续。
