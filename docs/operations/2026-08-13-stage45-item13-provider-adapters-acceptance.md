# Stage 4.5 Item 13 — Provider Adapter acceptance

日期：2026-08-13

基线：`382bee420ca3f44b9d633ae0c3664ab8076e9ef0`

分支：`codex/stage45-item13-provider-adapters`

## 验收范围

- DeepSeek/OpenAI-compatible、Anthropic、Gemini 固定 endpoint adapter 与模型发现。
- 官方 JSON/SSE 夹具的请求形状、文本、tool call、usage、终止原因和安全错误归一化。
- HTTPS allowlist、DNS 公网地址校验与连接地址钉住；不跟随 redirect。
- Item 12 加密凭据短租；admin/CSRF/独立限流 R3 验证卡；成功后 CAS 激活，失败不激活。
- `DEEPSEEK_API_KEY_FILE` owner-only 文件 smoke；不输出 key、header、文本或原始响应。
- OpenAPI operation/schema、ADR-60 与 CHANGELOG；没有新增 migration。

## Focused 门禁

```bash
pnpm --filter @laundry/contracts build
pnpm --filter @laundry/domain build
pnpm --filter @laundry/server build
node --test apps/server/dist/ai/provider-adapters.test.js
node --test apps/server/dist/http/provider-validation-routes.test.js
node --test tools/local/ai-provider-smoke-secret.test.mjs
pnpm --filter @laundry/contracts exec vitest run test/openapi-snapshot.test.ts
pnpm exec eslint <Item-13 changed TS files> --max-warnings=0
pnpm exec prettier --check <Item-13 changed files>
git diff --check
```

结果：集成后协议夹具 10/10、连接验证 3/3、安全文件 2/2 通过；build/typecheck、OpenAPI snapshot、
focused ESLint、Prettier、文件规模与 diff check 通过。root 随后在 hk-vps 使用 Hermes 既有凭据的
root-only 临时副本完成真实 DeepSeek smoke：模型发现、`deepseek-v4-pro` 可用性、流式文本、整数 usage
与一次受控 tool call 均通过；输出未含 key、header 或生成文本。远端及本机临时凭据/bundle 已精确清理，
Hermes 原始配置未改。Item 13/15 集成后 `pnpm workspace:check` 全量通过，Edge SPA 内容寻址包已同步并
通过 `spa:check` 与 Edge 全包测试。

## 失败关闭边界

- 401/403、429、5xx、timeout、abort、malformed/oversized 响应只映射固定安全码。
- 选中模型未发现、feature hard-off、credential/model/session 版本漂移均不消费卡或激活凭据。
- base URL 不来自 wire/config；私网、link-local、IPv6 保留地址、userinfo、非 HTTPS 和 redirect 均拒绝。
- 与 Item 15 集成后，四个内部工具名使用固定双向映射；未知工具、截断 tool stream 和未提供工具均在
  产生可执行事件前失败关闭。仍不包含写工具、自由 URL/provider。
