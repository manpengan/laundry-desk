# Stage 4.5 Item 12 — BYOK custody acceptance

日期：2026-08-13
基线：`d37692c5cb6ab63699a9a647fa6f307270f1e17b`
分支：`codex/stage45-item12-byok`

## 已验收范围

- 0064 只建立 `ai_model_registry` 与 `ai_provider_keys`，不 seed provider/model。
- 每份凭据使用随机 DEK、随机 12-byte nonce、AES-256-GCM、16-byte tag 与四元 AAD；DEK 由 KMS
  port wrap，应用没有明文环境变量 KEK。
- replace/revoke 是 admin-only、`ai_key_manage`、CSRF、限流与另一管理员 R5 单次 proof 的专用 HTTP
  流程。secret 不进入 pending、响应、审计或错误上下文。
- org FORCE RLS、app 无 DELETE/TRUNCATE、不可变密文身份、状态 trigger、单 active/pending 和有界
  历史已由 0064 静态契约覆盖。
- API 只返回 last4/metadata；AI feature 仍为 false；无 provider SDK import、网络请求或推理入口。

## 新鲜 focused 证据

完成 commit 前执行：

```bash
pnpm --filter @laundry/contracts exec vitest run test/byok-contract.test.ts
pnpm --filter @laundry/db exec vitest run test/byok-migration.test.ts test/schema-contract.test.ts
pnpm --filter @laundry/server build
node --test --test-concurrency=1 \
  apps/server/dist/ai/byok-envelope.test.js \
  apps/server/dist/ai/byok-memory-store.test.js \
  apps/server/dist/http/byok-routes.test.js
pnpm --filter @laundry/contracts typecheck
pnpm --filter @laundry/db typecheck
pnpm --filter @laundry/server typecheck
pnpm exec eslint packages/contracts/src/ai packages/contracts/test/byok-contract.test.ts \
  packages/db/test/byok-migration.test.ts apps/server/src/ai apps/server/src/http/byok-*.ts \
  --ext .ts --max-warnings=0
```

新鲜结果：contracts `3/3`、DB migration/schema `32/32`、Server crypto/lifecycle/HTTP
`10/10`；三个 package typecheck、focused ESLint、Prettier check 与 `git diff --check` 均通过。Server
回归包含 provider→pending 统一锁序，以及 KMS 工作期间撤销 creator 会话后，事务内重验失败且不
落库/不消费 pending 的 TOCTOU 场景。

## 明确未验收/失败关闭边界

- 本 Item 不含生产 KMS adapter；没有注入 adapter 时 replace 返回 `RESOURCE_UNAVAILABLE`。
- 本 Item 不含 provider 请求、SDK、模型选择、验证、推理、SSE、tool loop、UI 或自动化。
- 0064 必须集成到真实 0054–0063 之后再运行连续 migration bundle 与 real-PG/RLS/backup-restore 门禁；
  当前隔离基线只有 0053，不能单独形成可部署迁移链。
- PostgreSQL restore 不携带 KMS KEK。正式恢复必须证明旧 key versions 仍可 unwrap；缺失时必须重新
  走 R5 录入，不能降级为明文恢复。
