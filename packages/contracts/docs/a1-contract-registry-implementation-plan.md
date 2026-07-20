# A1 Command Registry Contract Implementation Plan

> 执行方式：使用 `superpowers:subagent-driven-development`，每个实现任务先写失败测试，再做规格审查和质量审查。

**目标：** 按 ADR-09 冻结可运行时校验、不可伪造、不可变且类型安全的命令/查询定义契约，供 C1/C4/C5/Edge 复用。

**边界：** 仅修改 `packages/contracts/**` 与两份 lockfile；不实现注册 Map、执行器、Policy 求值、脱敏 walker、领域命令或 A2 错误信封。

## Task 1：测试工具链与严格类型边界

**文件：** `package.json`、`tsconfig.test.json`、`vitest.config.ts`、`test/tooling.test.ts`、两份 lockfile。

- [ ] 先增加断言，要求测试配置不存在 `skipLibCheck: true`，覆盖率阈值不少于 70%。
- [ ] 对齐 package-local Vitest/Vite/Rollup 类型图；不得用 `skipLibCheck` 隐藏依赖声明冲突。
- [ ] 加入 V8 coverage provider 与 lines/functions/branches/statements 70% 门槛。
- [ ] 同步 `package-lock.json` 与 `pnpm-lock.yaml`，禁 lifecycle scripts。
- [ ] 验证 lint、strict typecheck、smoke test 与 coverage。

## Task 2：基础值、路径与 ADR-09 阈值 schema

**文件：** `src/registry/schemas.ts`、`test/schema-primitives.test.ts`、`test/limits.test.ts`。

- [ ] 先覆盖 SemVer、点分绑定名、安全 JSON Pointer、重复脱敏路径的失败/成功边界。
- [ ] 实现 `OfflineModeSchema`、命令/查询数据分类、输入/结果脱敏规则。
- [ ] 实现 batch/amount 两维 `size_measures`、`hard_limits`、`risk_escalation` 严格 schema。
- [ ] `numeric_sum.field` 只允许安全的单个 own-property snake_case 键；补原型污染负向测试。
- [ ] 覆盖“阈值必须有 measure”与“升级线不得高于硬上限”两条现行 ADR-09 良构约束，并保留等线测试供配对评审裁决。
- [ ] 实现并测试 `validateStricterLimitOverride()`：只能收紧，不能新增出厂未声明维度，合并后重新验证良构。

## Task 3：命令与查询元数据 schema

**文件：** `src/registry/schemas.ts`、`test/command-metadata.test.ts`、`test/query-metadata.test.ts`。

- [ ] 命令六个安全维度齐全：risk、idempotent、offline_mode、data_classification、limits、redaction；另含 `description_llm`。
- [ ] 验证离线授权必须幂等；secret 必须 R5、denied 且有输入脱敏。
- [ ] 非空风险升级只允许基础 R3；secret 输入脱敏只允许 `remove`。
- [ ] 查询固定 R0–R2、幂等、无不变量/副作用、offline denied，并要求正安全整数 `max_result_rows`。
- [ ] PII 查询必须 R2 且结果脱敏非空；查询禁止 secret。
- [ ] 所有字段补 TSDoc/规范引用，所有 metadata schema `.strict()`。

## Task 4：可信构造器与不可变定义

**文件：** `src/registry/definitions.ts`、`test/definitions.test.ts`、`test/types.test.ts`。

- [ ] 先断言 caller 提供匹配/冲突 `kind` 均失败，拒绝 `z.any()`、数组、strip/passthrough object 和伪造解析器。
- [ ] 构造器先严格解析不含 `kind` 的 caller input，再由包内附加判别字段，禁止静默覆盖。
- [ ] 对输入 object schema 建立严格快照，缓存 shape；保留根级 refinement、input/output 推导与公开 metadata；冻结所有可序列化嵌套值，不改调用者对象。
- [ ] 使用非导出唯一品牌和 WeakSet 来源标记，实现 `isContractDefinition()`。
- [ ] 保留判别联合与 `InferContractInput` / `InferContractOutput` 推导。

## Task 5：R5 投影守卫、导出面与消费样例

**文件：** `src/index.ts`、`test/consumers.test.ts`、`README.md`。

- [ ] 实现 `isAiProjectableDefinition()`，R5 必须 false，并以类型守卫收窄可投影定义。
- [ ] 只导出 A1 支持面，不泄漏私有品牌或内部 schema 组装细节。
- [ ] 添加 C1 来源验证、C4 R5 排除、C5 覆盖校验三个编译/运行样例。
- [ ] README 记录字段到规范映射和 A1 评审六项冻结答复。

## Task 6：验收、审查与交付

- [ ] 保持单文件不超过 400 行，先跑聚焦测试，再跑 package lint/typecheck/test/coverage/build。
- [ ] 跑根级 `pnpm run workspace:check`、`git diff --check` 和变更范围检查。
- [ ] 并行完成规格、TypeScript、静默失败与安全终审；修复所有重要问题后重跑。
- [ ] `git fetch origin && git rebase origin/main`，再次执行全量验证。
- [ ] 提交信息尾行带 `Co-Authored-By: Codex <codex@openai.com>`，推送并创建 A1 PR，停下等待 Claude 结对评审。
