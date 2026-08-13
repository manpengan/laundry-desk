# Stage 4.5 Item 17：有界自动化验收

## 验收范围

本记录覆盖 [ADR-63](../adr/2026-08-13-adr-63-bounded-automation.md) 的策略、调度、暂停、额度、运行证据和 Owner Web 最小管理面。它不把本地软件测试写成 hk-vps 发布、真实短信/微信送达或生产自动化验收。

## 已实现纵向

| 层                | 验收内容                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Contracts/OpenAPI | 6 条管理命令、3 条查询、严格 Zod、R1–R3 风险、M2 registry/OpenAPI 快照；tool 只允许通知批次                               |
| PostgreSQL 0069   | 策略、日额度、运行记录；FORCE RLS、应用直写撤销、admin SECURITY DEFINER 写入口、策略/额度行锁、租约与失败关闭             |
| Server            | Memory + PG store、统一 command bus handler、`via=automation` worker、显式时钟/SQL/bus/provider 依赖、暂停/恢复和运行记录 |
| HTTP              | 复用认证命令/查询总线路由、owner surface allowlist、CSRF、会话/组织/门店自动化限流维度                                    |
| Owner Web         | 固定模板 CRUD、批准、暂停、恢复、归档、运行记录；generation + AbortController 阻止陈旧异步响应                            |

## 关键否定断言

- 不能登记 `notification.delivery_batch.enqueue@0.1.0` 之外的工具。
- 每次对象数不能超过 10；策略只允许固定 30/90/180 天、ready/racked 过滤和非跨午夜窗口。
- R4/R5、退款、免单、余额、权限、密钥、备份恢复与审计删除不在自动化 registry authority 内。
- 浏览器不能提交 org/store/staff、cron、SQL、脚本、URL、provider 地址或自由消息正文。
- 未批准、批准人不再是 active admin、有效期/窗口不符、租约冲突、额度不足或风险无法证明时均不执行。
- 应用角色不能直接写策略、日额度或运行证据；日额度甚至不可直接读取。

## 本分支验证口径

完成前运行以下 focused 门禁：

```text
pnpm --filter @laundry/contracts exec vitest run test/automation-contract.test.ts test/m2-freeze.test.ts test/tenant-table-matrix.test.ts test/openapi-snapshot.test.ts
pnpm --filter @laundry/db exec vitest run test/bounded-automation-migration.test.ts
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/db typecheck
pnpm --filter @laundry/server typecheck
pnpm --filter @laundry/web typecheck
pnpm --filter @laundry/server build
pnpm --filter @laundry/web build
pnpm --filter @laundry/contracts lint
pnpm --filter @laundry/db lint
pnpm --filter @laundry/server lint
pnpm --filter @laundry/web lint
```

另在一次隔离 PostgreSQL 16 容器中应用迁移并用应用角色实测：同门店 admin 创建/批准、到期调度、额度预占/超限暂停、运行记录、跨门店 RLS 与直接写拒绝。最终结果以本提交交付消息中的新鲜命令输出为准。

## 尚不声称

- 尚未在本独立分支完成 0065–0069 连续集成迁移、required CI、合入 main 或 hk-vps 部署。
- 尚无真实短信/微信 provider、外部费用、回执或生产顾客数据证据。
- 尚无跨门店调度、任意业务自动化或无人值守高风险写操作；这些均不属于本 ADR。
