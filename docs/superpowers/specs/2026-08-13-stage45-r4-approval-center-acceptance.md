# Stage 4.5 Item 16：R4 异步审批中心验收

> 状态：实现候选；最终交付仍以统一集成分支、真实 PostgreSQL、GitHub exact-main CI 和 hk-vps
> 单次发布证据为准。本文件不把独立 Item 分支测试冒充发布完成。

| 层                | 验收内容                                                                             | 候选证据                   |
| ----------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| Contracts/OpenAPI | submit/list/detail/approve/deny 严格 Zod；仅 R4；统一错误信封                        | 专项 contracts 与 snapshot |
| PostgreSQL        | `0068`、FORCE RLS、应用只读 ACL、DB 时钟、另一 active admin、permission/version、CAS | 专项迁移与真 PG            |
| Server            | 复用 pending/step-up/Command Bus；冻结 hash/entity/idempotency/expiry；审计同事务    | 专项 server                |
| Web               | Owner 待办/历史/详情/批准/驳回；完整参数；generation/Abort                           | 专项 Web                   |

## 必须成立的不变量

1. 只可由仍有效的 R4 step-up pending 创建；R3 不需要异步审批，R5 永远拒绝。
2. 发起人不能自批；决定与执行都重验批准人 active admin、双方 permission version 和门店范围。
3. Web 不回传业务 args；批准只提交 approval ref 与 expected version，执行读取服务器冻结副本。
4. hash、实体版本、幂等键、命令版本或有效期任一漂移均失败关闭；并发批准/消费只有一个胜者。
5. 异步批准最终调用唯一命令总线；业务写、pending/approval 消费和业务审计同事务。
6. 所有写路由有认证、CSRF、固定 body 上限和独立限流；响应、审计和日志不含会话 token。

## 本项不声称

- 不声称多级审批、跨店授权、委托/转签、催办通知或外部工作流已交付。
- 不声称桌面端同步 UI、provider 真调用、AI 自动化或 hk-vps 已发布。
- 独立分支存在 `0065–0067` 编号空档；只有统一串联后才能运行正式连续迁移门禁。
