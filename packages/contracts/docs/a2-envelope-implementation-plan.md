# A2 Command Envelope and Error Contract Implementation Plan

> 执行方式：先为每个边界写会失败的 Vitest 断言，再补最小实现；提交前进行 TypeScript 与安全审查。

**目标：** 冻结 C1 可消费的命令线路载荷、服务端命令信封、响应信封与错误码，保证租户/身份只能由服务端认证会话注入，并保留 ADR-05 的确认卡参数冻结边界。

**边界：** 只修改 `packages/contracts/**`。不实现 C1 校验链、C8 认证中间件、实际数据库幂等表、Policy 求值、A4 的租约验证或加签。

## 冻结裁定

- 线路载荷只含命令、版本、执行模式、幂等键与 `dry_run`，绝不接受 `actor` 或 `tenant`。
- 服务端信封只能由 `injectAuthenticatedCommandContext()` 创建；它带私有品牌与 `WeakMap` 来源登记，不能由结构相同的对象伪造。
- `direct` 与 `confirm` 使用判别式联合：确认模式只提交 `confirm_ref`，不能回传参数。
- `edge_replay` 在 A2 仅是 `via` 枚举值。`lease_id`、`primary_epoch`、`per_lease_seq` 由 A4 的带版本队列信封独占，避免两个信封对同一重放语义产生冲突。
- 错误详情只允许结构化、安全的字段路径或枚举原因；原始参数、PII、secret 和任意 metadata 对象均不构成错误契约的一部分。

## Task 1：先定义线路载荷并锁住确认卡形状

**文件：** `src/envelope/wire-payload.ts`、`test/wire-payload.test.ts`。

- [x] 先断言 direct/confirm 均可解析；带 `args` 与 `confirm_ref` 的对象、自报上下文、非 JSON 参数或无效幂等键均失败。
- [x] 实现严格的 `CommandWirePayloadSchema` 与推导类型，使用 `mode` 判别联合。
- [x] 断言线路对象含自报 `actor` 或 `tenant` 时失败，证明它不能穿过 C8 的注入边界。
- [x] 运行聚焦测试，确认红绿过程不是恒真断言。

## Task 2：服务端注入与不可伪造信封

**文件：** `src/envelope/server-envelope.ts`、`test/server-envelope.test.ts`、`test/envelope-types.test.ts`。

- [x] 先断言只有注入工厂产物通过 `isServerCommandEnvelope()`；展开、JSON 往返和手写同形对象均失败。
- [x] 定义严格的认证上下文 schema，穷举 `ui|ai|automation|edge_replay`，并要求 `staff_id`、`device_id`、`org_id`、`store_id` 是 UUID。
- [x] 使用未导出的 unique-symbol 品牌加 `WeakMap` 登记，产出深只读服务端信封；不导出可直接构造该品牌的机制。
- [x] 补编译期断言：wire payload 与 server envelope 双向不可赋值。

## Task 3：响应、错误码与安全详情

**文件：** `src/envelope/responses.ts`、`test/responses.test.ts`。

- [x] 先断言预演和已执行成功形状可判别；成功与错误使用严格、相斥的 `ok` 判别式联合。
- [x] 定义覆盖 Zod、RBAC、租户、Policy、不变量、事务、事件与幂等键的错误码；Policy 的确认/step-up/审批/拒绝四种结果必须不同，且 code 决定公开文案字面量。
- [x] 断言跨租户与资源不存在使用同码同文案；详情拒绝任意原始 args、secret 或对象回显。
- [x] 提供只接受安全结构化详情的工厂，供 C1 在调用 A1 脱敏规则后使用。

## Task 4：说明、导出与集成检查

**文件：** `src/index.ts`、`README.md`、`test/consumers.test.ts`。

- [x] 导出最小 A2 公共 API，不导出品牌、登记表或可伪造内部 schema。
- [x] 在 README 逐条回答评审单 §2.1–§2.6，并标明 C1/C3/C8/A4 的消费责任。
- [x] 运行 package lint、严格 typecheck、Vitest coverage、build 和 `git diff --check`。
- [ ] A1 合入后 rebase `origin/main`；提交、推送并交 Claude 逐项结对评审。
