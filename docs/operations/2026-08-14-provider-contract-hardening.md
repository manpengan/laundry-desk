# Provider 软件契约与失败关闭加固

日期：2026-08-14

证据等级：`software_only`

## 范围

本批只加固现有 provider-neutral 边界与验收工具，不接入新供应商，不读取真实密钥，不发起外网
请求，也不改变产品命令、查询、迁移或冻结清单。

## 已加固

- 通知 adapter 现在必须声明渠道、单批数量上限和回执能力；worker 在调用 `send` 前同时验证
  provider code、assurance、幂等、取消、回执、整数费用与批量上限。缺字段、非整数费用、渠道漂移、
  回执能力未证明或超出 adapter 批量上限时均失败关闭，provider 调用数保持为零并进入人工处理。
- DeepSeek smoke 的协议判断从实网 CLI 中拆为可独立测试的无网络核心。成功报告现在要求目标模型
  确实存在于模型发现结果，文本流至少产生一条有效 delta 和唯一终态，usage 为非负安全整数，工具流
  不得夹带文本，并且必须恰好调用一次 `synthetic.lookup`、使用精确合成参数后正常终止。
- CLI 继续只输出 provider、model、阶段、usage 和事件计数等受控元数据，不输出 credential、header、
  请求正文、模型文本或原始响应；安全文件读取与清零边界保持不变。

## 软件门禁

```bash
pnpm --filter @laundry/server build
node --test apps/server/dist/notification/delivery-worker.test.js
node --test tools/local/ai-provider-deepseek-smoke.test.mjs \
  tools/local/ai-provider-smoke-secret.test.mjs
pnpm run workspace:check
```

聚焦结果：通知 worker 8/8、AI smoke 与密钥文件 5/5 通过，全部使用内存 adapter 和合成值。
全量 `workspace:check` 通过：依赖审计为 high 0 / critical 0，lint、strict typecheck 与 build 的
9 个 workspace 全绿，Server 1167 项为 1065 pass / 102 个真实 PostgreSQL 用例按本地门禁设计跳过，
Cloud acceptance 304/304 通过；真实 PostgreSQL 仍由 PR required check 独立执行。

## 未取得

- 本批没有执行 `ai:provider:deepseek:smoke`，因此不刷新任何真实模型连接声明。
- 真实短信、微信和新的 AI provider 仍缺账号、模板、额度、签名回执、失败与撤销证据，继续标记
  `blocked_external_provider`；ADR-23 人工名单仍是通知外部依赖不可用时的安全路径。
- 没有部署、签名、公证、制品上传或线上数据操作。
